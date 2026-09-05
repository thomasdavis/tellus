import { type Vec3, type LightEnv, normalize } from '@tellus/engine';

/** Seconds for a full day. Starts at a warm mid-morning so first impressions are bright. */
export const DAY_LENGTH = 300;
const PHASE_START = 0.3;

interface Stop {
  p: number;
  zenith: Vec3;
  horizon: Vec3;
  sun: Vec3;
  amb: number;
  fog: Vec3;
}

// keyframed sky/light/fog through the day (0..255 linear-ish RGB)
const STOPS: Stop[] = [
  { p: 0.0, zenith: [6, 9, 22], horizon: [16, 18, 34], sun: [30, 36, 70], amb: 0.22, fog: [16, 18, 34] }, // midnight
  { p: 0.22, zenith: [70, 78, 124], horizon: [222, 142, 92], sun: [255, 140, 78], amb: 0.34, fog: [198, 148, 122] }, // dawn
  { p: 0.32, zenith: [96, 142, 214], horizon: [255, 198, 124], sun: [255, 210, 150], amb: 0.52, fog: [222, 198, 162] }, // golden AM
  { p: 0.5, zenith: [96, 152, 222], horizon: [212, 222, 236], sun: [255, 250, 238], amb: 0.62, fog: [202, 216, 234] }, // noon
  { p: 0.7, zenith: [100, 124, 194], horizon: [255, 172, 96], sun: [255, 186, 108], amb: 0.52, fog: [228, 172, 122] }, // golden PM
  { p: 0.8, zenith: [54, 50, 106], horizon: [232, 106, 80], sun: [255, 118, 68], amb: 0.32, fog: [182, 118, 118] }, // dusk
  { p: 1.0, zenith: [6, 9, 22], horizon: [16, 18, 34], sun: [30, 36, 70], amb: 0.22, fog: [16, 18, 34] }, // → midnight
];

const mix = (a: Vec3, b: Vec3, f: number): Vec3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];

export interface DayState {
  phase: number;
  sunDir: Vec3; // direction TOWARD the sun
  sunUp: number; // 0 at/below horizon .. 1 overhead
  night: number; // 0 day .. 1 deep night
  skyTop: Vec3;
  skyHorizon: Vec3;
  sunColor: Vec3;
  light: LightEnv;
}

export function dayState(t: number): DayState {
  const phase = ((t / DAY_LENGTH + PHASE_START) % 1 + 1) % 1;
  let i = 0;
  while (i < STOPS.length - 1 && STOPS[i + 1]!.p <= phase) i++;
  const a = STOPS[i]!;
  const b = STOPS[Math.min(i + 1, STOPS.length - 1)]!;
  const f = b.p > a.p ? (phase - a.p) / (b.p - a.p) : 0;
  const skyTop = mix(a.zenith, b.zenith, f);
  const skyHorizon = mix(a.horizon, b.horizon, f);
  const sunColor = mix(a.sun, b.sun, f);
  const fog = mix(a.fog, b.fog, f);
  const amb = a.amb + (b.amb - a.amb) * f;

  // sun rides an arc: rises in the east ~phase 0.25, sets west ~0.75
  const ang = phase * Math.PI * 2 - Math.PI / 2;
  const elev = Math.sin(ang);
  const sunDir = normalize([Math.cos(ang), Math.max(-0.95, elev), 0.34]);
  const sunUp = Math.max(0, elev);
  const night = Math.max(0, -elev);
  const diffuse = 0.14 + 0.62 * Math.max(0, elev + 0.08);

  return {
    phase,
    sunDir,
    sunUp,
    night,
    skyTop,
    skyHorizon,
    sunColor,
    light: {
      dir: [-sunDir[0], -sunDir[1], -sunDir[2]], // light travels away from the sun
      ambient: amb,
      diffuse,
      fog: { color: fog, near: 58, far: 168 },
    },
  };
}
