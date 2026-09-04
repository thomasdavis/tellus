import { lerp, lerpAngle, type Anim } from '@tellus/protocol';
import type { RemoteSample } from './NetClient.js';

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  anim: Anim;
}

/** Sample a remote's buffered history at render time `t`, blending the two
 *  surrounding snapshots. Clamps to the ends when `t` falls outside the buffer. */
export function sampleRemote(buf: RemoteSample[], t: number): Pose | null {
  const n = buf.length;
  if (n === 0) return null;
  const first = buf[0]!;
  if (n === 1 || t <= first.t) return { x: first.x, z: first.z, yaw: first.yaw, anim: first.anim };
  const last = buf[n - 1]!;
  if (t >= last.t) return { x: last.x, z: last.z, yaw: last.yaw, anim: last.anim };
  for (let i = 0; i < n - 1; i++) {
    const a = buf[i]!;
    const b = buf[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), yaw: lerpAngle(a.yaw, b.yaw, u), anim: u < 0.5 ? a.anim : b.anim };
    }
  }
  return { x: last.x, z: last.z, yaw: last.yaw, anim: last.anim };
}
