import type { EntityState } from './messages.js';
import type { Anim } from './constants.js';

/**
 * Binary snapshot codec. Position updates are the hot path — every player, many
 * times a second — so they ride a packed little-endian buffer instead of JSON.
 *
 * Layout:
 *   u8   kind (BinaryKind.Snapshot)
 *   u32  serverTick
 *   u32  ackSeq       last input sequence the server processed for THIS client
 *   u16  entityCount
 *   entityCount × {
 *     u16  id
 *     f32  x
 *     f32  z
 *     f32  yaw
 *     u8   anim
 *   }
 * → 11-byte header + 15 bytes/entity.
 *
 * `ackSeq` is what makes client reconciliation possible: the client discards
 * every buffered input up to and including it, then replays the rest.
 */
export const BinaryKind = { Snapshot: 1 } as const;

const HEADER = 11;
const PER_ENTITY = 15;

export function encodeSnapshot(tick: number, ackSeq: number, ents: readonly EntityState[]): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + ents.length * PER_ENTITY);
  const dv = new DataView(buf);
  dv.setUint8(0, BinaryKind.Snapshot);
  dv.setUint32(1, tick >>> 0, true);
  dv.setUint32(5, ackSeq >>> 0, true);
  dv.setUint16(9, ents.length, true);
  let o = HEADER;
  for (const e of ents) {
    dv.setUint16(o, e.id, true);
    dv.setFloat32(o + 2, e.x, true);
    dv.setFloat32(o + 6, e.z, true);
    dv.setFloat32(o + 10, e.yaw, true);
    dv.setUint8(o + 14, e.anim);
    o += PER_ENTITY;
  }
  return buf;
}

export interface DecodedSnapshot {
  tick: number;
  ackSeq: number;
  ents: EntityState[];
}

export function decodeSnapshot(data: ArrayBuffer): DecodedSnapshot | null {
  const dv = new DataView(data);
  if (dv.byteLength < HEADER || dv.getUint8(0) !== BinaryKind.Snapshot) return null;
  const tick = dv.getUint32(1, true);
  const ackSeq = dv.getUint32(5, true);
  const count = dv.getUint16(9, true);
  const ents: EntityState[] = [];
  let o = HEADER;
  for (let i = 0; i < count && o + PER_ENTITY <= dv.byteLength; i++) {
    ents.push({
      id: dv.getUint16(o, true),
      x: dv.getFloat32(o + 2, true),
      z: dv.getFloat32(o + 6, true),
      yaw: dv.getFloat32(o + 10, true),
      anim: dv.getUint8(o + 14) as Anim,
    });
    o += PER_ENTITY;
  }
  return { tick, ackSeq, ents };
}
