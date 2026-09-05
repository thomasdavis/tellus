// A third-person chase camera: orbits a target by yaw/pitch, trails it with
// critically-damped smoothing so starts, stops and turns glide instead of snapping.
import { lerp, type Vec3 } from '../math/index.js';

export interface ChaseCameraConfig {
  back: number; // orbit distance behind the target
  up: number; // height above the target's ground anchor
  damp: number; // per-frame eye smoothing (0..1, higher = snappier)
  pitchRate: number; // how fast pitch eases toward its target (per second)
  lookHeight: number; // where on the target the camera aims, above the ground
}

export const DEFAULT_CHASE: ChaseCameraConfig = { back: 6.8, up: 2.5, damp: 0.32, pitchRate: 8, lookHeight: 1.15 };

export class ChaseCamera {
  yaw: number;
  pitchTarget: number;
  private pitch: number;
  private _eye: Vec3 | null = null;

  constructor(
    private readonly cfg: ChaseCameraConfig = DEFAULT_CHASE,
    yaw = Math.PI,
    pitch = 0.22,
  ) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.pitchTarget = pitch;
  }

  /** Rotate the orbit (radians; positive = clockwise looking down). */
  turn(delta: number): void {
    this.yaw += delta;
  }

  /** Ease pitch toward `pitchTarget` — call every simulation step. */
  easePitch(dt: number): void {
    this.pitch += (this.pitchTarget - this.pitch) * Math.min(1, dt * this.cfg.pitchRate);
  }

  /** The last computed eye position (null until the first frame). */
  get eye(): Vec3 | null {
    return this._eye;
  }

  /** Advance the damped trail toward the target at (x, groundY, z) and return
   *  this frame's eye + look. Call once per rendered frame. */
  frame(x: number, groundY: number, z: number): { eye: Vec3; look: Vec3 } {
    const { back, up, damp, lookHeight } = this.cfg;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const horiz = back * Math.cos(this.pitch);
    const height = up + back * Math.sin(this.pitch);
    const want: Vec3 = [x - fx * horiz, groundY + height, z - fz * horiz];
    this._eye = this._eye
      ? [lerp(this._eye[0], want[0], damp), lerp(this._eye[1], want[1], damp), lerp(this._eye[2], want[2], damp)]
      : want;
    return { eye: this._eye, look: [x, groundY + lookHeight, z] };
  }
}
