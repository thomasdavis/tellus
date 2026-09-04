# Tellus

A shared-world MMORPG slice: pick an avatar from the [Flobots 3D Asset Manager](https://3d.flobots.xyz)
and run around a world together, in real time, in your browser.

It's a **Turborepo** monorepo built around a few deliberately small, reusable abstractions:

```
apps/
  client/   Vite + React Three Fiber — the 3D world, character select, HUD
  server/   authoritative WebSocket world server (fixed-tick simulation)
packages/
  protocol/ the wire contract: constants, messages, binary snapshot codec
  world/    shared simulation: the movement integrator, ECS, spatial-hash grid
  assets/   pulls avatars/props from the Flobots asset manager → a runtime manifest
```

## The netcode, in one breath

The keystone is **one movement function** (`packages/world/movement.ts`) run on both ends:

- **Prediction** — the client integrates your input the instant you press a key.
- **Reconciliation** — every snapshot carries the last input the server processed; the
  client snaps to that authoritative position and replays the inputs still in flight.
- **Interpolation** — other players are rendered ~120 ms in the past and blended between
  snapshots, so they glide instead of teleporting.
- **Interest management** — a spatial-hash grid means each client only hears about the
  players near them, so bandwidth stays flat as the world fills up.

## Run it

```bash
pnpm install
pnpm assets          # download avatars + props from 3d.flobots.xyz → client/public/models
pnpm dev             # turbo runs the world server + the client together
# open http://localhost:5173  — open it in two tabs to see multiplayer
```

Individual pieces: `pnpm --filter @tellus/server dev` · `pnpm --filter @tellus/client dev`.

## Notes

- The asset library is mixed: animals become **playable characters**, furniture/trees become
  **world props**. It's all data — edit `apps/client/public/models/manifest.json` to recategorize.
- Everything is TypeScript end-to-end; internal `@tellus/*` packages are consumed as source
  (no build step) so a change in the protocol is immediately typed on both client and server.
