// Soft ground shadows as depth-gated screen splats. Cast while only the ground
// (terrain + grass) is in the depth buffer, so every finite-depth pixel under an
// object's footprint is ground and gets darkened — an ellipse pushed away from
// the sun and stretched as the sun sinks. Cheap, and it plants everything on the
// land instead of letting it float.
import { type Mat4, RasterTarget, type Frustum } from '@tellus/engine';
import type { DayState } from '../nature/daynight.js';
import type { World } from '../world/world.js';

/** Anything standing on the ground that should pool a shadow beneath it. */
export interface ShadowCaster {
  cx: number;
  cz: number;
  baseY: number;
  radius: number;
}

export function castShadows(
  target: RasterTarget,
  vp: Mat4,
  frustum: Frustum,
  day: DayState,
  world: World,
  props: readonly ShadowCaster[],
): void {
  const strength = 0.5 * day.sunUp;
  if (strength < 0.04) return; // no cast shadows at night
  const { width: W, height: H, rgb, depth } = target;
  const sd = day.sunDir;
  let ox = -sd[0], oz = -sd[2];
  const ol = Math.hypot(ox, oz) || 1;
  ox /= ol;
  oz /= ol; // ground direction the shadow falls (away from the sun)
  const stretch = 1 + (1 - day.sunUp) * 1.8; // longer near sunrise/sunset

  const proj = (x: number, y: number, z: number): number[] | null => {
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.05) return null;
    const sx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw;
    const sy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
    return [(sx * 0.5 + 0.5) * W, (1 - (sy * 0.5 + 0.5)) * H];
  };

  const splat = (cx: number, cz: number, gy: number, r: number): void => {
    if (frustum.culls(cx, gy, cz, r + 2)) return;
    const bx = cx + ox * r * 0.5 * stretch;
    const bz = cz + oz * r * 0.5 * stretch;
    const by = gy + 0.04;
    const c = proj(bx, by, bz);
    if (!c) return;
    const e1 = proj(bx + r, by, bz), e2 = proj(bx, by, bz + r);
    if (!e1 || !e2) return;
    let rx = Math.max(Math.hypot(e1[0]! - c[0]!, e1[1]! - c[1]!), Math.hypot(e2[0]! - c[0]!, e2[1]! - c[1]!));
    if (rx < 1) return;
    rx = Math.min(rx, W * 0.5);
    const ry = Math.max(1, rx * 0.5); // foreshortened onto the ground plane
    const px = c[0]!, py = c[1]!;
    const x0 = Math.max(0, (px - rx) | 0), x1 = Math.min(W, (px + rx + 1) | 0);
    const y0 = Math.max(0, (py - ry) | 0), y1 = Math.min(H, (py + ry + 1) | 0);
    const irx = 1 / rx, iry = 1 / ry;
    for (let y = y0; y < y1; y++) {
      const ndy = (y - py) * iry;
      for (let x = x0; x < x1; x++) {
        const ndx = (x - px) * irx;
        const d2 = ndx * ndx + ndy * ndy;
        if (d2 >= 1) continue;
        const di = y * W + x;
        if (depth[di] === Infinity) continue; // sky — nothing to darken
        const k = 1 - strength * (1 - d2) * (1 - d2); // soft, darkest at centre
        const o = di * 3;
        rgb[o] *= k;
        rgb[o + 1] *= k;
        rgb[o + 2] *= k;
      }
    }
  };

  for (const p of props) {
    if (p.baseY > world.groundAt(p.cx, p.cz) + 2) continue; // floating (balloons)
    splat(p.cx, p.cz, p.baseY, (p.radius - 1) * 0.85);
  }
  for (const a of world.agents()) {
    const gy = world.groundAt(a.x, a.z);
    splat(a.x, a.z, gy, 1.1);
  }
}
