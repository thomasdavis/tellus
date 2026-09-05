// Deterministic sailing simulation: shared wave field, wind, planar boat physics + derived pose.
// Authoritative motion is on the X/Z ocean plane; heel/pitch/roll/heave are derived for visuals.

export interface WaveComponent { dx: number; dz: number; amp: number; wavelength: number; speed: number; phase: number; }

// A small, deterministic sea: 4 directional sine components. Same function is used by
// the physics (boat pose) and the visual ocean mesh, so they never disagree.
export const SEA: WaveComponent[] = [
  { dx: 0.86, dz: 0.51, amp: 0.42, wavelength: 15, speed: 3.2, phase: 0.0 },
  { dx: -0.4, dz: 0.92, amp: 0.30, wavelength: 9, speed: 2.6, phase: 1.7 },
  { dx: 0.97, dz: -0.24, amp: 0.18, wavelength: 5.5, speed: 2.1, phase: 4.1 },
  { dx: 0.2, dz: 0.98, amp: 0.11, wavelength: 3.2, speed: 1.7, phase: 2.3 },
];

export interface WaveSample { height: number; gx: number; gz: number; }

/** Wave height and analytic gradient (dh/dx, dh/dz) at world (x,z) and time t. */
export function waveAt(x: number, z: number, t: number, out?: WaveSample): WaveSample {
  let h = 0, gx = 0, gz = 0;
  for (let i = 0; i < SEA.length; i++) {
    const w = SEA[i];
    const k = (2 * Math.PI) / w.wavelength;
    const phase = k * (w.dx * x + w.dz * z) - w.speed * t + w.phase;
    const s = Math.sin(phase), c = Math.cos(phase);
    h += w.amp * s;
    gx += w.amp * c * k * w.dx;
    gz += w.amp * c * k * w.dz;
  }
  if (out) { out.height = h; out.gx = gx; out.gz = gz; return out; }
  return { height: h, gx, gz };
}

export interface Wind { dirFrom: number; speed: number; } // dirFrom: radians the wind blows FROM (0 = from +Z/north)

/** True wind velocity vector (the air's motion), from `dirFrom`. */
export function trueWindVec(w: Wind): [number, number] {
  // wind FROM dirFrom means air moves TOWARD dirFrom+PI
  return [-Math.sin(w.dirFrom) * w.speed, -Math.cos(w.dirFrom) * w.speed];
}

export interface BoatState {
  x: number; z: number; vx: number; vz: number;
  yaw: number; yawRate: number;
  rudder: number;   // -1..1
  trim: number;     // 0..1 (0 eased, 1 hauled)
  autoTrim: boolean;
  // derived visual pose
  heel: number; heelVel: number; pitch: number; roll: number; heave: number;
  // telemetry
  speed: number; awAngle: number; sailEff: number; vmg: number;
}

export function newBoat(x = 0, z = 0, yaw = 0): BoatState {
  return {
    x, z, vx: 0, vz: 0, yaw, yawRate: 0,
    rudder: 0, trim: 0.5, autoTrim: false,
    heel: 0, heelVel: 0, pitch: 0, roll: 0, heave: 0,
    speed: 0, awAngle: 0, sailEff: 0, vmg: 0,
  };
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const TWO_PI = Math.PI * 2;
function wrapPi(a: number): number { a %= TWO_PI; if (a > Math.PI) a -= TWO_PI; else if (a < -Math.PI) a += TWO_PI; return a; }

// Drive efficiency vs true-wind angle off the bow (0 = into wind, PI = dead downwind).
function pointOfSail(beta: number): number {
  const b = Math.abs(beta);
  if (b < 0.62) return 0;                        // < ~35deg: no-go / irons
  if (b < 1.6) return (b - 0.62) / (1.6 - 0.62); // build to full by ~92deg (close-haul -> beam)
  if (b < 2.5) return 1;                          // beam/broad reach: fastest
  return 1 - 0.45 * ((b - 2.5) / (Math.PI - 2.5));// dead downwind a touch slower
}

const AIR = 1.2;
export const BOAT = {
  mass: 300, sailArea: 16, driveCoeff: 0.34,
  forwardDrag: 11.0, lateralDrag: 58.0, angularDrag: 220,
  rudderAuthority: 55, maxHeel: 0.32, inertia: 500,
};

/** One fixed physics step (dt seconds). Mutates and returns state. */
export function stepBoat(s: BoatState, wind: Wind, t: number, dt: number): BoatState {
  const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
  const fwd: [number, number] = [sy, cy];         // bow direction (yaw 0 -> +Z)
  const right: [number, number] = [cy, -sy];

  const [twx, twz] = trueWindVec(wind);
  const awx = twx - s.vx, awz = twz - s.vz;        // apparent wind
  const awSpeed = Math.hypot(awx, awz) || 1e-4;

  // true-wind angle off the bow
  const windFromX = -twx, windFromZ = -twz;
  const wfLen = Math.hypot(windFromX, windFromZ) || 1e-4;
  const beta = Math.acos(clamp((fwd[0] * windFromX + fwd[1] * windFromZ) / wfLen, -1, 1));
  const sideSign = Math.sign(right[0] * windFromX + right[1] * windFromZ) || 1; // wind on which side

  // auto vs manual trim: optimal eased angle grows with beta
  const optimalTrim = clamp(1 - beta / Math.PI, 0.05, 0.95);
  const trim = s.autoTrim ? optimalTrim : s.trim;
  const trimErr = trim - optimalTrim;
  const trimEff = Math.max(0, 1 - 2.2 * trimErr * trimErr - (trimErr < 0 ? 1.4 * -trimErr : 0));

  const eff = pointOfSail(beta) * trimEff;
  s.sailEff = eff;
  s.awAngle = beta;

  // aerodynamic drive along the bow + side force that heels the boat
  const q = 0.5 * AIR * awSpeed * awSpeed * BOAT.sailArea;
  const drive = q * BOAT.driveCoeff * eff;
  const side = drive * 0.55 * sideSign;

  let fx = fwd[0] * drive + right[0] * side;
  let fz = fwd[1] * drive + right[1] * side;

  // anisotropic hull/keel drag (low forward, high lateral)
  const fwdSpeed = s.vx * fwd[0] + s.vz * fwd[1];
  const sideSpeed = s.vx * right[0] + s.vz * right[1];
  fx += -fwd[0] * BOAT.forwardDrag * fwdSpeed * Math.abs(fwdSpeed) - right[0] * BOAT.lateralDrag * sideSpeed * Math.abs(sideSpeed);
  fz += -fwd[1] * BOAT.forwardDrag * fwdSpeed * Math.abs(fwdSpeed) - right[1] * BOAT.lateralDrag * sideSpeed * Math.abs(sideSpeed);

  // integrate planar velocity/position (semi-implicit Euler)
  s.vx += (fx / BOAT.mass) * dt;
  s.vz += (fz / BOAT.mass) * dt;
  s.x += s.vx * dt;
  s.z += s.vz * dt;

  // rudder torque depends on water flow; no spin at rest, authority saturates with speed
  const rud = Math.sign(s.rudder) * Math.pow(Math.abs(s.rudder), 1.3);
  const flow = Math.max(-3, Math.min(3, fwdSpeed));
  const torque = rud * BOAT.rudderAuthority * flow - BOAT.angularDrag * s.yawRate;
  s.yawRate += (torque / BOAT.inertia) * dt;
  s.yaw = wrapPi(s.yaw + s.yawRate * dt);

  // derived pose
  s.speed = Math.hypot(s.vx, s.vz);
  // heel: target from side force + wave roll, critically damped spring
  const targetHeel = clamp(-side * 0.010 - sideSpeed * 0.04, -BOAT.maxHeel, BOAT.maxHeel);
  const k = 90, c = 2 * Math.sqrt(k);
  const heelAcc = k * (targetHeel - s.heel) - c * s.heelVel;
  s.heelVel += heelAcc * dt;
  s.heel += s.heelVel * dt;

  // wave-driven pitch/roll/heave sampled at the hull
  const half = 2.6;
  const bow = waveAt(s.x + fwd[0] * half, s.z + fwd[1] * half, t);
  const stern = waveAt(s.x - fwd[0] * half, s.z - fwd[1] * half, t);
  const port = waveAt(s.x - right[0] * 1.3, s.z - right[1] * 1.3, t);
  const stbd = waveAt(s.x + right[0] * 1.3, s.z + right[1] * 1.3, t);
  s.heave = (bow.height + stern.height + port.height + stbd.height) * 0.25;
  s.pitch = Math.atan2(stern.height - bow.height, half * 2) * 0.8;
  s.roll = s.heel + Math.atan2(stbd.height - port.height, 2.6) * 0.5;

  // velocity made good toward the wind (upwind progress)
  s.vmg = -(s.vx * windFromX + s.vz * windFromZ) / wfLen;
  return s;
}

// discrete control commands (terminal-friendly: no key-up needed)
export type Command = 'rudder-left' | 'rudder-right' | 'rudder-center'
  | 'trim-in' | 'trim-out' | 'auto-trim' | 'recover';

export function applyCommand(s: BoatState, cmd: Command): void {
  switch (cmd) {
    case 'rudder-left': s.rudder = clamp(s.rudder - 0.2, -1, 1); break;
    case 'rudder-right': s.rudder = clamp(s.rudder + 0.2, -1, 1); break;
    case 'rudder-center': s.rudder = 0; break;
    case 'trim-in': s.trim = clamp(s.trim + 0.1, 0, 1); s.autoTrim = false; break;
    case 'trim-out': s.trim = clamp(s.trim - 0.1, 0, 1); s.autoTrim = false; break;
    case 'auto-trim': s.autoTrim = !s.autoTrim; break;
    case 'recover': s.vx = s.vz = s.yawRate = 0; s.heel = s.heelVel = 0; break;
  }
}
