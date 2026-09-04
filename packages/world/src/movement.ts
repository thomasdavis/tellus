import {
  WALK_SPEED,
  RUN_SPEED,
  WORLD_HALF,
  PLAYER_RADIUS,
  Anim,
  clamp,
  normalize2,
  type Input,
} from '@tellus/protocol';

export interface MoveState {
  x: number;
  z: number;
  yaw: number;
  anim: Anim;
}

/**
 * The single source of truth for how a player moves.
 *
 * This pure function is the keystone of the whole netcode: the client runs it to
 * PREDICT its own motion the instant a key is pressed, and the server runs the
 * exact same function to produce the AUTHORITATIVE result. Because the inputs
 * (position + Input command) and the maths are identical, the two converge — and
 * when they briefly disagree (a dropped packet, a shove) reconciliation replays
 * the unacknowledged inputs through this same function to snap back cleanly.
 *
 * Convention: yaw 0 faces +Z. Forward = (sin yaw, cos yaw); right is +90°.
 */
export function integrate(state: MoveState, input: Input): MoveState {
  const speed = input.run ? RUN_SPEED : WALK_SPEED;
  const cos = Math.cos(input.yaw);
  const sin = Math.sin(input.yaw);

  // camera-relative movement basis on the ground plane
  const desiredX = sin * input.f + cos * input.r;
  const desiredZ = cos * input.f - sin * input.r;
  const dir = normalize2(desiredX, desiredZ);
  const moving = dir.x !== 0 || dir.z !== 0;

  const dt = clamp(input.dt, 0, 0.1); // guard against long frames / tab-outs
  const bound = WORLD_HALF - PLAYER_RADIUS;
  const x = clamp(state.x + dir.x * speed * dt, -bound, bound);
  const z = clamp(state.z + dir.z * speed * dt, -bound, bound);

  // avatars face where they run; standing still keeps the last facing
  const yaw = moving ? Math.atan2(dir.x, dir.z) : state.yaw;
  const anim: Anim = !moving ? Anim.Idle : input.run ? Anim.Run : Anim.Walk;

  return { x, z, yaw, anim };
}
