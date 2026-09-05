# Tellus MMO

A shared 3D world over SSH. Every connection is a player in the **same** storybook
city — a plaza, four districts, streets full of walking NPCs and cart traffic,
lanterns that light up at dusk. Built from ~400 models harvested from the Flobots
library.

```bash
ssh -p 4020 <host>        # your username becomes your character name
```

`WASD` run · `←/→` orbit the camera · `↑/↓` look · `V` render mode · `?` help

## Architecture

```
src/
  server/    ssh2 server: one guest session per connection, one shared World
  session.ts input, HUD, sim loop — ChaseCamera + TerminalPresenter from the engine
  render/    renderer.ts (frame composition) · sky.ts · shadows.ts · worker.ts · pool.ts
  nature/    wind.ts · grass.ts · particles.ts · daynight.ts
  world/     world.ts (agents, props, collision) · terrain.ts · mesh.ts (asset loading)
```

**One process, one world.** The main thread owns the simulation (30 Hz fixed-step)
and each session's HUD + ANSI diffing. Rasterization runs on a pool of stateless
worker threads: each worker rebuilds the deterministic world once, then receives
per-frame agent snapshots + camera and returns finished terminal cells. One frame
in flight per session; any worker failure falls back to inline rendering.

**The nature systems** share one wind field — a pure function of (time, position) —
so every viewer sees the same gust roll across the meadow. Grass is spatially
bucketed camera-facing cards bent by wind and passing players; the day-night cycle
keyframes sky, sun, fog and ambient light through dawn, noon, dusk and night;
fireflies come out after dark. Ground shadows are depth-gated splats cast while
only the terrain is in the depth buffer — cheap, soft, and they stretch with a
sinking sun.

## Tools

```bash
pnpm test              # render-worker parity: worker output must be byte-identical
pnpm bench             # full-pipeline ms/frame at typical terminal sizes
pnpm snapshot out.png pov 0.32    # render the world to a PNG (mode: pov|aerial, day phase 0..1)
tsx tools/mptest.ts    # headless two-player visibility check
tsx tools/convert-all.mjs         # re-fetch + compile world models from 3d.flobots.xyz
```

## Configuration

| env | default | |
|---|---|---|
| `MMO_PORT` / `MMO_HOST` | `4020` / `0.0.0.0` | listen address |
| `MMO_NO_POOL` | unset | `1` disables the render worker pool (inline rendering) |
| `LOD0` / `LOD1` | `64` / `140` | distances (m) where model detail steps down |

On first run the server prints the `ssh-keygen` command for its host key
(`assets/host.key`, gitignored).

Compiled world models (`assets/meshes/`) ship in-repo so the world runs out of
the box; they come from the [Flobots 3D Asset Manager](https://3d.flobots.xyz).
