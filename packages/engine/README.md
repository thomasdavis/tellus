# @tellus/engine

**A terminal-native 3D engine.** CPU rasterizer in, ANSI out. No GPU, no DOM,
no dependencies — a few thousand lines of TypeScript that turn world geometry
into truecolour Unicode at interactive rates over SSH.

```
math/       vectors, 4×4 matrices, lookAt/perspective builders
raster/     the software rasterizer: RasterTarget + renderMesh
scene/      Frustum culling · selectLod · ChaseCamera
terminal/   Screen cells · octant/half fitting · ANSI diffing · TerminalPresenter
workers/    WorkerPool — parallel off-thread rendering
```

Everything is exported from the package root: `import { renderMesh, Frustum, TerminalPresenter } from '@tellus/engine'`.

## The pipeline

### 1. Rasterize — `raster/`

`renderMesh(target, viewProj, camPos, light, mesh)` draws an indexed triangle
mesh into a `RasterTarget` (packed RGB `Uint8Array` + `Float32Array` depth):

- **Per-vertex transform, once** — shared vertices are transformed to clip space
  a single time per mesh, not per triangle.
- **Near-plane fast path** — triangles fully in front of the near plane (the
  overwhelming common case) skip Sutherland–Hodgman clipping entirely; the rest
  are clipped properly.
- **Perspective-correct everything** — colour, UV and shade interpolate in
  1/w space, divided per pixel.
- **Shading** — Gouraud per-vertex lambert by default; `flat: true` for faceted
  looks, `unlit: true` for glow/particles.
- **Texturing** — optional per-pixel bilinear sampling from a packed RGB texture.
- **Distance fog** — folded into the per-pixel loop; the fog colour is your sky.
- **Opt-in backface culling** — `cull: true` skips back faces of closed solids.
  Leave it off for foliage cards and non-watertight meshes (their back faces are
  load-bearing: they fill silhouette gaps).

### 2. Present — `terminal/`

A `Screen` is a grid of terminal cells (codepoint + fg + bg). Two fitting modes:

- **`octant`** — each cell is a 2×4 sub-pixel block using the Unicode 16.0 octant
  glyphs: 8 real sub-pixels per character, split into bright/dark groups by
  luminance, quantized so sub-threshold shimmer doesn't flip cells. This is the
  crisp mode.
- **`half`** — the `▀` upper-half-block: 2 exact-colour sub-pixels per cell,
  works on every terminal ever made.

`diffToAnsi(cur, prev, keyframe)` emits only the cells that changed since the
last frame, with cursor-run and SGR-state coalescing — an idle scene costs a few
hundred bytes a second; a busy one stays comfortably inside SSH bandwidth.

`TerminalPresenter` wraps the whole lifecycle — current/previous screens, render
mode, colour quantization, keyframe bookkeeping, resize — so a game session is
just: render, `fit()` (or `adopt()` cells from a worker), draw HUD text, `flush()`.

### 3. Compose — `scene/`

- `Frustum.fromViewProj(vp).culls(x, y, z, r)` — bounding-sphere culling against
  the view frustum's side planes (Gribb–Hartmann extraction).
- `selectLod(lods, dist, near, far)` — distance-based level-of-detail pick.
- `ChaseCamera` — a third-person orbit camera with damped trailing and eased
  pitch. The "feels good" is in the defaults.

### 4. Parallelize — `workers/`

`WorkerPool<Req, Res>` is a tiny round-robin worker-thread pool with per-request
timeouts and automatic respawn of dead workers. Point it at a stateless render
worker and each player's frame rasterizes off the main thread — input latency
stays flat no matter how heavy the scene gets, and players render in parallel
across cores. The MMO's parity test proves worker output byte-identical to
inline rendering.

## Asset pipeline

`tools/compile-glb.mjs` compiles a GLB into engine-ready data: parses geometry,
bakes texture colour per vertex, generates LODs by grid clustering, normalizes
scale, and emits `<id>.mesh.json` + a packed `<id>.tex.bin`.

## Design constraints, embraced

- **~10 fps is the budget** — terminals and human eyes at cell scale don't need
  more; the engine spends the savings on resolution and geometry instead.
- **Determinism** — no hidden global state; a frame is a pure function of
  (meshes, camera, light, time). That's what makes worker pools and parity
  testing trivial.
- **Runtime-agnostic core** — `math`, `raster`, `scene` and `terminal` run
  anywhere JavaScript does; only `workers/` touches Node APIs.
