// The MMO's render pool: the engine's generic WorkerPool typed to this game's
// frame protocol, pointed at the stateless render worker.
import { WorkerPool, type RenderMode, type Vec3 } from '@tellus/engine';
import type { AgentSnapshot } from '../world/world.js';
import type { NameTag } from './renderer.js';

export interface FrameReq {
  viewerId: number;
  eye: Vec3;
  look: Vec3;
  cols: number;
  rows: number;
  mode: RenderMode;
  tSec: number;
  agents: AgentSnapshot[];
}

export interface FrameRes {
  cols: number;
  rows: number;
  ch: Uint32Array;
  fg: Int32Array;
  bg: Int32Array;
  tags: NameTag[];
}

export class RenderPool extends WorkerPool<FrameReq, FrameRes> {
  constructor(size: number) {
    super(new URL('./worker.ts', import.meta.url), size, { execArgv: process.execArgv });
  }

  /** Render one frame on some worker. Rejects on timeout/worker death — caller renders inline. */
  render(req: FrameReq): Promise<FrameRes> {
    return this.run(req);
  }
}
