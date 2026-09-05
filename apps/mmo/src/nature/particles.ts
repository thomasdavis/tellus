import { type Mat4, type Vec3, RasterTarget } from '@tellus/engine';
import { windState } from './wind.js';
import { WORLD_HALF } from '../world/terrain.js';
import type { World } from '../world/world.js';
import type { DayState } from './daynight.js';

/**
 * Ambient motes. Positions are a pure function of time (so every viewer agrees):
 * fireflies drift and blink near the ground at night; pale pollen drifts on the
 * wind by day. Drawn as additive glows splatted straight into the framebuffer.
 */
export class Particles {
  private readonly cx: Float32Array;
  private readonly cz: Float32Array;
  private readonly seed: Float32Array;
  private readonly n = 40;

  constructor() {
    const cx: number[] = [];
    const cz: number[] = [];
    const seed: number[] = [];
    let s = 4242;
    const r = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
    for (let i = 0; i < this.n; i++) {
      cx.push((r() * 2 - 1) * WORLD_HALF);
      cz.push((r() * 2 - 1) * WORLD_HALF);
      seed.push(r() * 100);
    }
    this.cx = Float32Array.from(cx);
    this.cz = Float32Array.from(cz);
    this.seed = Float32Array.from(seed);
  }

  render(target: RasterTarget, vp: Mat4, eye: Vec3, day: DayState, t: number, world: World): void {
    const { width: W, height: H, rgb } = target;
    const w = windState(t);
    const gr = Math.max(1, Math.round(Math.min(W, H) * 0.012));
    const night = day.night;

    for (let i = 0; i < this.n; i++) {
      const fly = i % 2 === 0;
      const amount = fly ? night : Math.max(0, 1 - night * 1.4);
      if (amount < 0.12) continue;

      const p = this.seed[i]!;
      let x: number;
      let z: number;
      let y: number;
      let cr: number;
      let cg: number;
      let cb: number;
      if (fly) {
        // firefly: slow wander + blink, hovering just above the grass
        x = this.cx[i]! + 6 * Math.sin(t * 0.3 + p) + 2 * Math.sin(t * 0.9 + p * 2);
        z = this.cz[i]! + 6 * Math.cos(t * 0.27 + p) + 2 * Math.cos(t * 1.1 + p * 3);
        y = world.groundAt(x, z) + 0.8 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.8 + p));
        const blink = 0.25 + 0.75 * Math.max(0, Math.sin(t * (1.5 + (p % 1)) + p * 4));
        const v = amount * blink;
        cr = 150 * v;
        cg = 220 * v;
        cb = 90 * v;
      } else {
        // pollen: drifts downwind, catches the daylight, floats higher
        const drift = t * (0.4 + 0.4 * w.strength);
        x = this.cx[i]! + w.dx * drift * 6 + 3 * Math.sin(t * 0.5 + p);
        z = this.cz[i]! + w.dz * drift * 6 + 3 * Math.cos(t * 0.4 + p);
        x = ((x + WORLD_HALF) % (WORLD_HALF * 2)) - WORLD_HALF; // wrap
        z = ((z + WORLD_HALF) % (WORLD_HALF * 2)) - WORLD_HALF;
        y = world.groundAt(x, z) + 1.5 + 1.2 * Math.sin(t * 0.6 + p);
        const v = amount * (0.4 + 0.3 * day.sunUp);
        cr = 230 * v;
        cg = 224 * v;
        cb = 180 * v;
      }

      const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (cw <= 0.05) continue;
      const sxp = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw;
      const syp = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
      const px = (sxp * 0.5 + 0.5) * W;
      const py = (1 - (syp * 0.5 + 0.5)) * H;
      for (let dy = -gr; dy <= gr; dy++) {
        const yy = (py + dy) | 0;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -gr; dx <= gr; dx++) {
          const xx = (px + dx) | 0;
          if (xx < 0 || xx >= W) continue;
          const falloff = Math.max(0, 1 - (dx * dx + dy * dy) / (gr * gr + 1));
          if (falloff <= 0) continue;
          const o = (yy * W + xx) * 3;
          rgb[o] = Math.min(255, rgb[o] + cr * falloff);
          rgb[o + 1] = Math.min(255, rgb[o + 1] + cg * falloff);
          rgb[o + 2] = Math.min(255, rgb[o + 2] + cb * falloff);
        }
      }
    }
  }
}
