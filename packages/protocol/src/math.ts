/** Minimal ground-plane math. Positions live on the XZ plane; Y is the up axis. */
export interface Vec2 {
  x: number;
  z: number;
}

export const vec2 = (x = 0, z = 0): Vec2 => ({ x, z });

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const length2 = (x: number, z: number): number => Math.hypot(x, z);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest-path angular interpolation (radians), so avatars never spin the long way. */
export function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** Normalise a 2-vector to unit length; returns {0,0} for a zero vector. */
export function normalize2(x: number, z: number): Vec2 {
  const len = Math.hypot(x, z);
  return len > 1e-6 ? { x: x / len, z: z / len } : { x: 0, z: 0 };
}
