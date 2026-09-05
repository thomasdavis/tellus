import { type Mat4, type Vec3, RasterTarget, renderMesh, cross, normalize, type LightEnv } from '@tellus/engine';
import { sway, windState } from './wind.js';
import { WORLD_HALF, roadDist } from '../world/terrain.js';
import type { World } from '../world/world.js';

const CULL = 16;
const CULL_SQ = CULL * CULL;
const CELL = 16; // spatial bucket size (m)
const REACH = Math.ceil(CULL / CELL) + 1;
const BLADES = 2;
const BEND = 2.4;

const key = (cx: number, cz: number): number => (((cx + 2048) << 12) | (cz + 2048)) | 0;
function hash(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Ground-cover grass. World-anchored positions bucketed into a spatial grid so a
 * frame only touches the ~few hundred tufts near the viewer. Blades are built into
 * a dynamic mesh each frame, bent by the shared wind, and shoved aside by players.
 */
export class Grass {
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly cells = new Map<number, number[]>();
  private readonly pos: Float32Array;
  private readonly nor: Float32Array;
  private readonly col: Uint8Array;
  private readonly idx: Uint32Array;
  private readonly maxTufts = 1500;

  constructor(world: World, density = 1.4) {
    const count = Math.floor((WORLD_HALF * 2) ** 2 * density);
    const xs: number[] = [];
    const zs: number[] = [];
    let seed = 987;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let i = 0; i < count; i++) {
      const x = (rnd() * 2 - 1) * WORLD_HALF;
      const z = (rnd() * 2 - 1) * WORLD_HALF;
      if (roadDist(x, z) < 0.7) continue; // nothing grows through cobblestones
      if (world.buildings.some((b) => Math.hypot(x - b.x, z - b.z) < b.r + 1)) continue;
      const idx = xs.length;
      xs.push(x);
      zs.push(z);
      const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(idx);
    }
    this.px = Float32Array.from(xs);
    this.pz = Float32Array.from(zs);

    const cap = this.maxTufts * BLADES * 4;
    this.pos = new Float32Array(cap * 3);
    this.nor = new Float32Array(cap * 3);
    this.col = new Uint8Array(cap * 3);
    this.idx = new Uint32Array(this.maxTufts * BLADES * 6);
  }

  render(target: RasterTarget, vp: Mat4, eye: Vec3, look: Vec3, light: LightEnv, t: number, world: World): void {
    const fwd = normalize([look[0] - eye[0], 0, look[2] - eye[2]]);
    const right = normalize(cross([0, 1, 0], fwd));
    const players = [...world.players.values()];
    const w = windState(t);

    let vo = 0;
    let io = 0;
    let vbase = 0;
    let tufts = 0;

    const ecx = Math.floor(eye[0] / CELL);
    const ecz = Math.floor(eye[2] / CELL);
    for (let dcx = -REACH; dcx <= REACH && tufts < this.maxTufts; dcx++) {
      for (let dcz = -REACH; dcz <= REACH && tufts < this.maxTufts; dcz++) {
        const bucket = this.cells.get(key(ecx + dcx, ecz + dcz));
        if (!bucket) continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          if (tufts >= this.maxTufts) break;
          const i = bucket[bi]!;
          const x = this.px[i]!;
          const z = this.pz[i]!;
          const dx = x - eye[0];
          const dz = z - eye[2];
          if (dx * dx + dz * dz > CULL_SQ) continue;
          if (dx * fwd[0] + dz * fwd[2] < -2) continue;

          const gy = world.groundAt(x, z);
          const th = hash(x, z);
          let br = 40 + th * 22;
          let bg = 74 + th * 44;
          let bb = 36 + th * 18;
          let tr = br + 26;
          let tg = bg + 60;
          let tb = bb + 26;
          if (hash(z, x) > 0.9) {
            tr = 158;
            tg = 166;
            tb = 90;
          }
          const s1 = sway(x, z, w, t, 1);
          const shimmer = Math.min(1, (Math.abs(s1.x) + Math.abs(s1.z)) * 1.9) * 18;
          tr = Math.min(255, tr + shimmer * 0.5);
          tg = Math.min(255, tg + shimmer);
          tb = Math.min(255, tb + shimmer * 0.4);

          for (let b = 0; b < BLADES; b++) {
            const a = hash(x + b * 3.1, z - b * 1.7);
            const ang = a * Math.PI * 2;
            const bx = x + Math.cos(ang) * 0.28 * a;
            const bz = z + Math.sin(ang) * 0.28 * a;
            const h = 0.38 + a * 0.55;
            let tx = bx + s1.x * h;
            let tz = bz + s1.z * h;
            for (const p of players) {
              const pd = Math.hypot(bx - p.x, bz - p.z);
              if (pd < 2.2) {
                const push = ((2.2 - pd) / 2.2) * BEND;
                tx += ((bx - p.x) / (pd || 1)) * push * h;
                tz += ((bz - p.z) / (pd || 1)) * push * h;
              }
            }
            const ty = gy + h - Math.min(0.25, Math.hypot(tx - bx, tz - bz) * 0.3);
            const hb = 0.055;
            const ht = 0.014;
            this.pos[vo] = bx - right[0] * hb; this.pos[vo + 1] = gy; this.pos[vo + 2] = bz - right[2] * hb;
            this.pos[vo + 3] = bx + right[0] * hb; this.pos[vo + 4] = gy; this.pos[vo + 5] = bz + right[2] * hb;
            this.pos[vo + 6] = tx + right[0] * ht; this.pos[vo + 7] = ty; this.pos[vo + 8] = tz + right[2] * ht;
            this.pos[vo + 9] = tx - right[0] * ht; this.pos[vo + 10] = ty; this.pos[vo + 11] = tz - right[2] * ht;
            for (let k2 = 0; k2 < 4; k2++) {
              this.nor[vo + k2 * 3] = 0;
              this.nor[vo + k2 * 3 + 1] = 1;
              this.nor[vo + k2 * 3 + 2] = 0;
            }
            this.col[vo] = br; this.col[vo + 1] = bg; this.col[vo + 2] = bb;
            this.col[vo + 3] = br; this.col[vo + 4] = bg; this.col[vo + 5] = bb;
            this.col[vo + 6] = tr; this.col[vo + 7] = tg; this.col[vo + 8] = tb;
            this.col[vo + 9] = tr; this.col[vo + 10] = tg; this.col[vo + 11] = tb;
            this.idx[io] = vbase; this.idx[io + 1] = vbase + 1; this.idx[io + 2] = vbase + 2;
            this.idx[io + 3] = vbase; this.idx[io + 4] = vbase + 2; this.idx[io + 5] = vbase + 3;
            vo += 12;
            io += 6;
            vbase += 4;
          }
          tufts++;
        }
      }
    }

    if (io === 0) return;
    renderMesh(target, vp, eye, light, {
      positions: this.pos.subarray(0, vo),
      normals: this.nor.subarray(0, vo),
      colors: this.col.subarray(0, vo),
      indices: this.idx.subarray(0, io),
    });
  }
}
