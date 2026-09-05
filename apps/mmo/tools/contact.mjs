// Renders every catalog model as an isolated thumbnail into one grid image, so we
// can see which models are worth featuring. Prints an index → id/title map.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  RasterTarget, renderMesh, mul, lookAt, perspective, normalize,
} from '@tellus/engine';
import { loadModel } from '../src/world/mesh.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(HERE, '../assets/meshes/catalog.json'), 'utf8'));
const OUT = process.argv[2] || '/tmp/contact.png';

const TILE = 132;
const COLS = 9;
const rows = Math.ceil(catalog.length / COLS);
const GW = COLS * TILE;
const GH = rows * TILE;
const grid = new Uint8Array(GW * GH * 3);
for (let i = 0; i < grid.length; i += 3) { grid[i] = 30; grid[i + 1] = 34; grid[i + 2] = 40; }

const LIGHT = { dir: normalize([-0.4, -0.7, -0.4]), ambient: 0.7, diffuse: 0.6, fog: { color: [30, 34, 40], near: 1e5, far: 1e6 } };

for (let idx = 0; idx < catalog.length; idx++) {
  const c = catalog[idx];
  let m;
  try { m = loadModel(c.id); } catch { continue; }
  const lod = m.lods[0];
  if (!lod) continue;
  const P = lod.positions;
  let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
  for (let k = 0; k < P.length; k += 3) {
    mnx = Math.min(mnx, P[k]); mxx = Math.max(mxx, P[k]);
    mny = Math.min(mny, P[k + 1]); mxy = Math.max(mxy, P[k + 1]);
    mnz = Math.min(mnz, P[k + 2]); mxz = Math.max(mxz, P[k + 2]);
  }
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, cz = (mnz + mxz) / 2;
  const rad = Math.max(mxx - mnx, mxy - mny, mxz - mnz) * 0.62 || 1;
  const t = new RasterTarget(TILE, TILE);
  for (let k = 0; k < t.rgb.length; k += 3) { t.rgb[k] = 28; t.rgb[k + 1] = 32; t.rgb[k + 2] = 38; }
  t.clearDepth();
  const d = rad * 2.6;
  const eye = [cx + d * 0.7, cy + d * 0.5, cz + d * 0.7];
  const vp = mul(perspective(0.8, 1, 0.05, d * 8), lookAt(eye, [cx, cy, cz], [0, 1, 0]));
  renderMesh(t, vp, eye, LIGHT, { positions: P, normals: lod.normals, colors: lod.colors, indices: lod.indices, uvs: lod.uvs, texture: m.texture });
  // blit tile into grid
  const gx = (idx % COLS) * TILE, gy = Math.floor(idx / COLS) * TILE;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const s = (y * TILE + x) * 3, dst = ((gy + y) * GW + (gx + x)) * 3;
      grid[dst] = t.rgb[s]; grid[dst + 1] = t.rgb[s + 1]; grid[dst + 2] = t.rgb[s + 2];
    }
  }
}

await sharp(Buffer.from(grid), { raw: { width: GW, height: GH, channels: 3 } }).png().toFile(OUT);
console.log('wrote', OUT, `(${COLS}x${rows} grid, index reads left→right, top→bottom)`);
catalog.forEach((c, i) => console.log(`${String(i).padStart(2)} ${c.kind.padEnd(9)} ${(c.title || '').slice(0, 40)}`));
