import type { Mesh } from './mesh.js';

/** Half-extent of the (square) world in metres — room for a village in the woods. */
export const WORLD_HALF = 76;

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

/** Rolling terrain with fine bumps; flattened toward spawn so it stays walkable. */
export function heightAt(x: number, z: number): number {
  const big = fbm(x * 0.03, z * 0.03) - 0.5; // broad hills, -0.5..0.5
  const fine = (fbm(x * 0.16, z * 0.16) - 0.5) * 0.35; // surface roughness
  const flat = Math.min(1, Math.hypot(x, z) / 16); // calm meadow at the centre
  return Math.max(0, (big * 7.5 + fine * 2 + 1.1) * flat);
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
