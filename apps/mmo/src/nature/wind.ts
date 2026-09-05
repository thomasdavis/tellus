// One global wind field drives everything that moves in the breeze — grass, tree
// foliage, falling leaves, flags. It's a pure function of time + position so every
// viewer of the shared world sees the exact same gust travel across the meadow.

export interface WindState {
  dx: number;
  dz: number;
  strength: number;
}

/** Prevailing wind direction (unit) + overall gust strength (~0.2..1.4) at time t.
 *  Compute ONCE per frame and pass into `sway` — it's constant over the whole field. */
export function windState(t: number): WindState {
  const dir = 0.7 + 0.35 * Math.sin(t * 0.021) + 0.12 * Math.sin(t * 0.09 + 1.3);
  const breathe = 0.5 + 0.5 * Math.sin(t * 0.11) * Math.sin(t * 0.037 + 2);
  return { dx: Math.sin(dir), dz: Math.cos(dir), strength: 0.5 + 0.9 * breathe };
}

/**
 * Horizontal sway offset at (x,z), scaled by `heightFrac` (0 at the anchored base
 * → 1 at the free tip, squared so the base barely moves). Gusts travel ALONG the
 * wind as a wave, so ripples roll across the field. `w` is a per-frame windState.
 */
export function sway(x: number, z: number, w: WindState, t: number, heightFrac: number, stiffness = 1): { x: number; z: number } {
  const along = x * w.dx + z * w.dz;
  const phase = along * 0.5 - t * 1.6;
  const wave = Math.sin(phase) + 0.35 * Math.sin(phase * 2.7 + 1.3);
  const gust = 0.45 + 0.55 * Math.sin(along * 0.08 - t * 1.0);
  const amp = (0.27 * w.strength * gust * heightFrac * heightFrac) / stiffness;
  return { x: w.dx * wave * amp, z: w.dz * wave * amp };
}

/** High-frequency per-leaf flutter, layered on top of the bulk sway for foliage. */
export function flutter(x: number, z: number, t: number, amp: number): { x: number; z: number } {
  return {
    x: Math.sin(x * 5.1 + t * 9.0) * Math.cos(z * 4.3 - t * 7.0) * amp,
    z: Math.cos(x * 3.7 - t * 8.0) * Math.sin(z * 6.1 + t * 6.0) * amp,
  };
}
