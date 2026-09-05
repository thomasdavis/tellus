// The sky: a vertical day-phase gradient, stars that fade in through dusk, and
// the sun (or moon) as a bright disc inside a soft glow. Painted straight into
// the framebuffer before the depth pass, so everything else draws over it.
import { type Mat4, type Vec3, RasterTarget, lerp } from '@tellus/engine';
import type { DayState } from '../nature/daynight.js';

/** Deterministic star field on the upper hemisphere (unit directions). */
export function makeStars(count = 160, seed = 7): Vec3[] {
  const stars: Vec3[] = [];
  let ss = seed;
  const r = (): number => ((ss = (ss * 1103515245 + 12345) & 0x7fffffff), ss / 0x7fffffff);
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const el = 0.15 + r() * 0.8;
    const c = Math.cos(Math.asin(el));
    stars.push([Math.cos(a) * c, el, Math.sin(a) * c]);
  }
  return stars;
}

/** Project a world-space direction to a screen point (null when behind the camera). */
function projectDir(vp: Mat4, eye: Vec3, dir: Vec3, W: number, H: number): { x: number; y: number } | null {
  const px = eye[0] + dir[0] * 500;
  const py = eye[1] + dir[1] * 500;
  const pz = eye[2] + dir[2] * 500;
  const cw = vp[3] * px + vp[7] * py + vp[11] * pz + vp[15];
  if (cw <= 0.01) return null;
  const cx = vp[0] * px + vp[4] * py + vp[8] * pz + vp[12];
  const cy = vp[1] * px + vp[5] * py + vp[9] * pz + vp[13];
  return { x: (cx / cw * 0.5 + 0.5) * W, y: (1 - (cy / cw * 0.5 + 0.5)) * H };
}

export function paintSky(target: RasterTarget, day: DayState, vp: Mat4, eye: Vec3, stars: Vec3[]): void {
  const { width: W, height: H, rgb } = target;
  const top = day.skyTop;
  const hz = day.skyHorizon;
  for (let y = 0; y < H; y++) {
    const tt = Math.min(1, y / (H * 0.72));
    const r = lerp(top[0], hz[0], tt);
    const g = lerp(top[1], hz[1], tt);
    const b = lerp(top[2], hz[2], tt);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  // stars, fading in through dusk into night
  if (day.night > 0.12) {
    const bright = Math.min(1, (day.night - 0.12) / 0.4) * 210;
    for (const s of stars) {
      const p = projectDir(vp, eye, s, W, H);
      if (!p || p.x < 0 || p.x >= W || p.y < 0 || p.y >= H * 0.72) continue;
      const o = ((p.y | 0) * W + (p.x | 0)) * 3;
      rgb[o] = Math.min(255, rgb[o] + bright);
      rgb[o + 1] = Math.min(255, rgb[o + 1] + bright);
      rgb[o + 2] = Math.min(255, rgb[o + 2] + bright * 1.1);
    }
  }
  // the sun by day, the moon by night — a bright disc inside a soft glow
  const isDay = day.sunUp > 0.02;
  if (isDay || day.night > 0.05) {
    const bodyDir: Vec3 = isDay ? day.sunDir : [-day.sunDir[0], -day.sunDir[1], -day.sunDir[2]];
    const p = projectDir(vp, eye, bodyDir, W, H);
    if (p) {
      const glow: Vec3 = isDay ? [Math.min(255, day.sunColor[0] + 40), Math.min(255, day.sunColor[1] + 26), day.sunColor[2]] : [210, 216, 236];
      const disc: Vec3 = isDay ? [255, 250, 236] : [236, 240, 250];
      const gr = Math.min(W, H) * (isDay ? 0.16 : 0.08);
      for (let y = Math.max(0, (p.y - gr * 2) | 0); y < Math.min(H, p.y + gr * 2); y++) {
        for (let x = Math.max(0, (p.x - gr * 2) | 0); x < Math.min(W, p.x + gr * 2); x++) {
          const d = Math.hypot(x - p.x, y - p.y);
          const gv = Math.max(0, 1 - (d / gr) ** 2);
          if (gv <= 0) continue;
          const core = d < gr * 0.45;
          const cc = core ? disc : glow;
          const w = core ? 1 : gv * 0.8;
          const o = (y * W + x) * 3;
          rgb[o] = lerp(rgb[o], cc[0], w);
          rgb[o + 1] = lerp(rgb[o + 1], cc[1], w);
          rgb[o + 2] = lerp(rgb[o + 2], cc[2], w);
        }
      }
    }
  }
}
