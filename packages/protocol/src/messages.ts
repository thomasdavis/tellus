import type { Anim } from './constants.js';

/**
 * A single frame of player intent. The client stamps each with a monotonically
 * increasing `seq` and the `dt` it locally integrated, then keeps it in a buffer
 * until the server acknowledges it — that's what makes reconciliation possible.
 *
 * `f` (forward) and `r` (right) are camera-relative in [-1, 1]; `yaw` is the
 * facing the client chose. The shared movement integrator turns these into a
 * world-space position identically on both ends.
 */
export interface Input {
  seq: number;
  dt: number; // seconds integrated for this command
  f: number; // forward axis, -1..1
  r: number; // strafe axis, -1..1
  yaw: number; // facing, radians
  run: boolean;
}

/** The public, over-the-wire view of a player. */
export interface PlayerSnapshot {
  id: number;
  name: string;
  character: string; // asset id of the chosen avatar
  x: number;
  z: number;
  yaw: number;
  anim: Anim;
}

/** A compact position update carried in binary snapshot frames. */
export interface EntityState {
  id: number;
  x: number;
  z: number;
  yaw: number;
  anim: Anim;
}

// ---- Client → Server (JSON control channel) ----
export type ClientMessage =
  | { t: 'hello'; v: number; name: string; character: string }
  | { t: 'input'; seq: number; dt: number; f: number; r: number; yaw: number; run: boolean }
  | { t: 'chat'; text: string }
  | { t: 'ping'; time: number };

// ---- Server → Client (JSON control channel; snapshots go over binary) ----
export type ServerMessage =
  | { t: 'welcome'; id: number; tick: number; you: PlayerSnapshot; players: PlayerSnapshot[]; worldHalf: number }
  | { t: 'join'; player: PlayerSnapshot }
  | { t: 'leave'; id: number }
  | { t: 'chat'; id: number; name: string; text: string }
  | { t: 'pong'; time: number }
  | { t: 'reject'; reason: string };

export const encodeClient = (m: ClientMessage): string => JSON.stringify(m);
export const decodeClient = (s: string): ClientMessage => JSON.parse(s) as ClientMessage;
export const encodeServer = (m: ServerMessage): string => JSON.stringify(m);
export const decodeServer = (s: string): ServerMessage => JSON.parse(s) as ServerMessage;
