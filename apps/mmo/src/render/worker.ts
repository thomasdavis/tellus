// Stateless render worker. Builds its own copy of the (deterministic) world +
// renderer once, then for each frame request: overwrites the dynamic agents from
// the snapshot, rasterizes the 3D view, fits it to a terminal Screen, and ships
// the cell buffers back. No per-session state lives here — the main thread owns
// game state, the HUD and the diff.
import { parentPort } from 'node:worker_threads';
import { RasterTarget, Screen, fbSize } from '@tellus/engine';
import { World } from '../world/world.js';
import { WorldRenderer, COLOR_QUANT } from './renderer.js';
import type { FrameReq, FrameRes } from './pool.js';

const world = new World();
const renderer = new WorldRenderer(world);

let target: RasterTarget | null = null;
let tfbW = 0;
let tfbH = 0;

parentPort!.on('message', (m: FrameReq & { reqId: number }) => {
  const [fbW, fbH] = fbSize(m.mode, m.cols, m.rows);
  if (!target || tfbW !== fbW || tfbH !== fbH) {
    target = new RasterTarget(fbW, fbH);
    tfbW = fbW;
    tfbH = fbH;
  }
  world.applySnapshot(m.agents);
  const tags = renderer.render(target, world, m.viewerId, m.eye, m.look, m.cols, m.rows, m.tSec);
  const screen = new Screen(m.cols, m.rows);
  screen.setFromFramebuffer(target.rgb, fbW, fbH, m.mode, COLOR_QUANT);
  const reply: FrameRes & { reqId: number } = { reqId: m.reqId, cols: m.cols, rows: m.rows, ch: screen.ch, fg: screen.fg, bg: screen.bg, tags };
  parentPort!.postMessage(reply, [screen.ch.buffer, screen.fg.buffer, screen.bg.buffer] as ArrayBuffer[]);
});

parentPort!.postMessage({ ready: true });
