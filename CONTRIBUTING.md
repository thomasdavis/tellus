# Contributing

## Setup

```bash
pnpm install        # Node >= 20, pnpm 11
pnpm typecheck      # every workspace must stay clean
pnpm test           # includes the MMO's render-worker parity test
```

Internal `@tellus/*` packages are consumed as **raw TypeScript** — no build step.
Servers run under `tsx`; a change anywhere is picked up on restart.

## Where things live

- `packages/engine` — the terminal 3D engine. Runtime-agnostic core (`math`,
  `raster`, `scene`, `terminal`); only `workers/` may touch Node APIs.
- `apps/mmo` — the shared-world game. Simulation + HUD on the main thread,
  rasterization on stateless worker threads.
- `apps/sailing` — the sailing game, on the same engine.
- `apps/client` + `apps/server` + `packages/{protocol,world,assets}` — the
  earlier browser experiment (WebSocket netcode, R3F client).

## The rules of the render path

1. **A frame is a pure function** of (world state, camera, time). No hidden
   state, no `Date.now()` inside render code — time comes in as a parameter.
   This is what keeps render workers stateless and testable.
2. **Prove rendering changes with pixels.** `pnpm --filter @tellus/mmo test`
   must stay byte-identical between inline and worker rendering. For visual
   changes, render before/after snapshots
   (`pnpm --filter @tellus/mmo snapshot out.png pov 0.32`) and eyeball them;
   for pure optimizations, the pixel diff should be zero.
3. **Measure, don't guess.** `pnpm --filter @tellus/mmo bench` before and after
   anything performance-motivated.

## Benchmarks & tools

All MMO tools live in `apps/mmo/tools/` and run with `tsx`. `snapshot.mjs`
renders the world to a PNG (POV or aerial, any day phase) — it's the fastest
way to see what a change actually looks like.
