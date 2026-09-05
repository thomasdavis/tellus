// View-frustum culling. Planes are pulled straight out of a view-projection
// matrix (Gribb–Hartmann) and normalized, so plane·point is a signed world-space
// distance and a bounding-sphere test is four dot products.
import type { Mat4 } from '../math/index.js';

export class Frustum {
  /** Four side planes, rows of [a,b,c,d] with the normal facing INTO the frustum. */
  private readonly p = new Float32Array(16);

  static fromViewProj(vp: Mat4): Frustum {
    const f = new Frustum();
    // clip rows: x=[0,4,8,12] y=[1,5,9,13] w=[3,7,11,15]
    const rows = [
      [vp[3] + vp[0], vp[7] + vp[4], vp[11] + vp[8], vp[15] + vp[12]], // left
      [vp[3] - vp[0], vp[7] - vp[4], vp[11] - vp[8], vp[15] - vp[12]], // right
      [vp[3] + vp[1], vp[7] + vp[5], vp[11] + vp[9], vp[15] + vp[13]], // bottom
      [vp[3] - vp[1], vp[7] - vp[5], vp[11] - vp[9], vp[15] - vp[13]], // top
    ];
    for (let i = 0; i < 4; i++) {
      const [a, b, c, d] = rows[i]!;
      const inv = 1 / (Math.hypot(a!, b!, c!) || 1);
      f.p[i * 4] = a! * inv;
      f.p[i * 4 + 1] = b! * inv;
      f.p[i * 4 + 2] = c! * inv;
      f.p[i * 4 + 3] = d! * inv;
    }
    return f;
  }

  /** True when the sphere lies entirely beyond one of the side planes — safe to skip drawing. */
  culls(x: number, y: number, z: number, radius: number): boolean {
    const p = this.p;
    for (let i = 0; i < 16; i += 4) {
      if (p[i]! * x + p[i + 1]! * y + p[i + 2]! * z + p[i + 3]! < -radius) return true;
    }
    return false;
  }
}
