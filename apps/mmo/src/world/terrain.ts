import type { Mesh } from './mesh.js';

/** Half-extent of the (square) world in metres — room for a city and its outskirts. */
export const WORLD_HALF = 120;

// ---- the street network -------------------------------------------------------
// The city is drawn around a central plaza with four avenues out to a ring road.
// Roads are data: everything else — terrain flattening, cobble colouring, grass
// suppression, NPC routing, building frontages — derives from these segments.

export interface RoadSeg {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  w: number; // half-width (m)
}

export const PLAZA_R = 14; // the central plaza (flat, paved)
const AVE = 58; // avenues run from the plaza to the ring road
const RING = 58; // ring-road radius

function ringSegs(r: number, n: number, w: number): RoadSeg[] {
  const out: RoadSeg[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    out.push({ x1: Math.cos(a0) * r, z1: Math.sin(a0) * r, x2: Math.cos(a1) * r, z2: Math.sin(a1) * r, w });
  }
  return out;
}

export const ROADS: RoadSeg[] = [
  { x1: 0, z1: PLAZA_R - 2, x2: 0, z2: AVE, w: 3.2 }, // north avenue → Old Town
  { x1: 0, z1: -(PLAZA_R - 2), x2: 0, z2: -AVE, w: 3.2 }, // south avenue → Market Street
  { x1: PLAZA_R - 2, z1: 0, x2: AVE, z2: 0, w: 3.2 }, // east avenue → Shrine Quarter
  { x1: -(PLAZA_R - 2), z1: 0, x2: -AVE, z2: 0, w: 3.2 }, // west avenue → Garden District
  ...ringSegs(RING, 20, 2.4), // the ring road
];

/** Distance from (x,z) to the nearest road centreline, minus that road's half-width
 *  (≤ 0 means "on the road"). The plaza counts as road. */
export function roadDist(x: number, z: number): number {
  let best = PLAZA_R > 0 ? Math.hypot(x, z) - PLAZA_R : Infinity; // plaza disc
  for (const s of ROADS) {
    const dx = s.x2 - s.x1;
    const dz = s.z2 - s.z1;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - s.x1) * dx + (z - s.z1) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = s.x1 + dx * t;
    const pz = s.z1 + dz * t;
    const d = Math.hypot(x - px, z - pz) - s.w;
    if (d < best) best = d;
  }
  return best;
}

/** A deterministic point on the road network (for NPC wandering / cart routes). */
export function roadPoint(rnd: () => number): { x: number; z: number } {
  const s = ROADS[Math.floor(rnd() * ROADS.length)]!;
  const t = rnd();
  const jitter = (rnd() * 2 - 1) * s.w * 0.6;
  const dx = s.x2 - s.x1;
  const dz = s.z2 - s.z1;
  const l = Math.hypot(dx, dz) || 1;
  return { x: s.x1 + dx * t - (dz / l) * jitter, z: s.z1 + dz * t + (dx / l) * jitter };
}

// ---- value noise (cheap, deterministic) ----
function hash(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise2(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x: number, z: number): number {
  return 0.5 * noise2(x, z) + 0.25 * noise2(x * 2 + 5.3, z * 2 - 1.7) + 0.125 * noise2(x * 4 - 9.1, z * 4 + 4.4);
}

/** Rolling terrain with fine bumps, pressed flat where the city's streets run. */
export function heightAt(x: number, z: number): number {
  const big = fbm(x * 0.03, z * 0.03) - 0.5; // broad hills, -0.5..0.5
  const fine = (fbm(x * 0.16, z * 0.16) - 0.5) * 0.35; // surface roughness
  const raw = Math.max(0, big * 7.5 + fine * 2 + 1.1);
  // streets and the plaza sit near grade; countryside rolls freely a few metres out
  const rd = roadDist(x, z);
  const f = rd < 0 ? 0.04 : Math.min(1, rd / 9);
  return raw * (0.04 + 0.96 * f * f);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function terrainColor(x: number, z: number, y: number, slope: number, out: Uint8Array, k: number): void {
  const g = fbm(x * 0.28 + 11, z * 0.28 - 7); // grass tone variation
  let r: number;
  let gg: number;
  let b: number;
  if (g < 0.5) {
    const t = g / 0.5; // shadowed deep green -> meadow green
    r = lerp(44, 80, t);
    gg = lerp(92, 134, t);
    b = lerp(44, 62, t);
  } else {
    const t = (g - 0.5) / 0.5; // meadow -> sun-dried yellow-green
    r = lerp(80, 150, t);
    gg = lerp(134, 156, t);
    b = lerp(62, 74, t);
  }
  // occasional bare-earth patches
  const dirt = fbm(x * 0.1 - 40, z * 0.1 + 60);
  if (dirt > 0.74) {
    const t = Math.min(1, (dirt - 0.74) / 0.18);
    r = lerp(r, 132, t);
    gg = lerp(gg, 104, t);
    b = lerp(b, 74, t);
  }
  // stony on steep faces, brighter on the crests
  if (slope > 0.5) {
    const t = Math.min(1, (slope - 0.5) / 0.5);
    r = lerp(r, 126, t);
    gg = lerp(gg, 118, t);
    b = lerp(b, 104, t);
  }
  // the streets: warm cobblestone with per-stone tone flicker, blended at the verge
  const rd = roadDist(x, z);
  if (rd < 1.2) {
    const cobble = 0.82 + 0.18 * hash(Math.floor(x * 1.6), Math.floor(z * 1.6));
    const cr = 148 * cobble;
    const cg = 138 * cobble;
    const cb = 122 * cobble;
    const t = rd < 0 ? 1 : 1 - rd / 1.2; // solid on the road, feathered on the verge
    r = lerp(r, cr, t);
    gg = lerp(gg, cg, t);
    b = lerp(b, cb, t);
  }
  const hn = Math.min(1, y / 6) * 0.14;
  out[k] = Math.min(255, r * (1 + hn));
  out[k + 1] = Math.min(255, gg * (1 + hn));
  out[k + 2] = Math.min(255, b * (1 + hn));
}

/** Static ground mesh over the whole world. */
export function buildTerrain(n = 96): Mesh {
  const step = (WORLD_HALF * 2) / (n - 1);
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Uint8Array(n * n * 3);
  const e = 0.9;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = -WORLD_HALF + c * step;
      const z = -WORLD_HALF + r * step;
      const y = heightAt(x, z);
      const k = (r * n + c) * 3;
      positions[k] = x;
      positions[k + 1] = y;
      positions[k + 2] = z;
      const hx = heightAt(x + e, z) - heightAt(x - e, z);
      const hz = heightAt(x, z + e) - heightAt(x, z - e);
      let nx = -hx;
      const ny = 2 * e;
      let nz = -hz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      const nyn = ny / nl;
      nz /= nl;
      normals[k] = nx;
      normals[k + 1] = nyn;
      normals[k + 2] = nz;
      terrainColor(x, z, y, 1 - nyn, colors, k);
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c;
      const b = a + 1;
      const d = a + n;
      const f = d + 1;
      idx.push(a, d, b, b, d, f);
    }
  }
  return { positions, normals, colors, indices: Uint32Array.from(idx) };
}

export interface TerrainChunk {
  mesh: Mesh;
  cx: number; // bounding-sphere centre
  cy: number;
  cz: number;
  radius: number;
}

/**
 * The ground split into a G×G grid of independent meshes so the renderer can
 * frustum-cull the (typically half) that fall behind or beside the camera —
 * each chunk carries only its own vertices, so culling one skips its transform
 * entirely. Sample points are identical to `buildTerrain(n)`, so the union is
 * byte-for-byte the same surface; only the draw is split.
 */
export function buildTerrainChunks(n = 60, g = 4): TerrainChunk[] {
  const step = (WORLD_HALF * 2) / (n - 1);
  const e = 0.9;
  const cells = n - 1;
  // split `cells` columns/rows into g groups as evenly as possible (last ones absorb remainder)
  const bounds: number[] = [0];
  for (let i = 0; i < g; i++) bounds.push(bounds[i]! + Math.floor((cells - bounds[i]!) / (g - i)));

  const vy = (x: number, z: number): number => heightAt(x, z);
  const chunks: TerrainChunk[] = [];
  for (let cr = 0; cr < g; cr++) {
    for (let cc = 0; cc < g; cc++) {
      const r0 = bounds[cr]!, r1 = bounds[cr + 1]!; // inclusive vertex index range
      const c0 = bounds[cc]!, c1 = bounds[cc + 1]!;
      const rn = r1 - r0 + 1, cn = c1 - c0 + 1;
      const positions = new Float32Array(rn * cn * 3);
      const normals = new Float32Array(rn * cn * 3);
      const colors = new Uint8Array(rn * cn * 3);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = -WORLD_HALF + c * step;
          const z = -WORLD_HALF + r * step;
          const y = vy(x, z);
          const k = ((r - r0) * cn + (c - c0)) * 3;
          positions[k] = x; positions[k + 1] = y; positions[k + 2] = z;
          const hx = vy(x + e, z) - vy(x - e, z);
          const hz = vy(x, z + e) - vy(x, z - e);
          let nx = -hx; const ny = 2 * e; let nz = -hz;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; const nyn = ny / nl; nz /= nl;
          normals[k] = nx; normals[k + 1] = nyn; normals[k + 2] = nz;
          terrainColor(x, z, y, 1 - nyn, colors, k);
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
      const idx: number[] = [];
      for (let r = 0; r < rn - 1; r++) {
        for (let c = 0; c < cn - 1; c++) {
          const a = r * cn + c, b = a + 1, d = a + cn, f = d + 1;
          idx.push(a, d, b, b, d, f);
        }
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const radius = Math.hypot(maxX - cx, maxY - cy, maxZ - cz);
      chunks.push({ mesh: { positions, normals, colors, indices: Uint32Array.from(idx) }, cx, cy, cz, radius });
    }
  }
  return chunks;
}

export interface Scatter {
  x: number;
  z: number;
  rot: number;
  scale: number;
}

/** Deterministic scatter of `count` points, kept clear of spawn + optional exclusions. */
export function scatterPoints(count: number, minR: number, seed0: number, avoid?: (x: number, z: number) => boolean): Scatter[] {
  const out: Scatter[] = [];
  let s = seed0;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s / 0x7fffffff);
  let guard = 0;
  while (out.length < count && guard++ < count * 30) {
    const x = (rnd() * 2 - 1) * (WORLD_HALF - 4);
    const z = (rnd() * 2 - 1) * (WORLD_HALF - 4);
    if (Math.hypot(x, z) < minR) continue;
    if (avoid && avoid(x, z)) continue;
    out.push({ x, z, rot: rnd() * Math.PI * 2, scale: 0.7 + rnd() * 0.7 });
  }
  return out;
}
