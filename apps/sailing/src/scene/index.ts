// Scene assembler: builds the sailing world each frame and renders it to a RasterTarget,
// then composites the HUD onto a half-block Screen.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  Vec3, Mat4, mul, translation, rotationX, rotationY, rotationZ, scaling,
  lookAt, perspective, transform4, transformDir, normalize, add, sub, scale as vscale, clamp, lerp,
  RasterTarget, renderMesh, LightEnv, DrawMesh, Texture, Screen,
} from '@tellus/engine';
import { BoatState, Wind, waveAt, trueWindVec } from '../sailing/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- boat mesh (compiled) with procedural fallback ----
export interface RuntimeMesh { positions: number[]; normals: number[]; colors: number[]; indices: number[]; uvs?: number[]; }
export interface BoatAsset { lods: RuntimeMesh[]; texture?: Texture; }

export function loadBoat(): BoatAsset { return { lods: loadBoatLods(), texture: loadBoatTexture() }; }

function loadBoatTexture(): Texture | undefined {
  try {
    const p = join(HERE, '../../assets/boat/boat.tex.bin');
    const buf = readFileSync(p);
    const width = buf.readUInt32LE(0), height = buf.readUInt32LE(4);
    if (width > 0 && height > 0 && buf.length >= 8 + width * height * 3) {
      return { width, height, data: new Uint8Array(buf.buffer, buf.byteOffset + 8, width * height * 3) };
    }
  } catch { /* no texture -> per-vertex colours */ }
  return undefined;
}

// Returns LODs high->low. Supports the new {lods:[...]} format, the old flat mesh,
// and a procedural fallback.
export function loadBoatLods(): RuntimeMesh[] {
  try {
    const p = join(HERE, '../../assets/boat/boat.mesh.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (Array.isArray(j.lods) && j.lods.length) {
      const lods = (j.lods as RuntimeMesh[]).filter((l) => l.positions?.length && l.indices?.length);
      lods.forEach(recolorIfFlat);
      if (lods.length) return lods;
    }
    if (j.positions?.length && j.indices?.length) { recolorIfFlat(j); return [j as RuntimeMesh]; }
  } catch { /* fall through */ }
  return [fallbackBoat()];
}
export function loadBoatMesh(): RuntimeMesh { return loadBoatLods()[0]; }

// If the compiled mesh has no real material colours (near-uniform), paint a
// readable ship palette by height: dark waterline -> wood hull -> cream sails/rig.
function recolorIfFlat(m: RuntimeMesh): void {
  const P = m.positions, C = m.colors;
  let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0;
  for (let i = 0; i < P.length; i += 3) { const y = P[i + 1]; if (y < mn) mn = y; if (y > mx) mx = y; }
  for (let i = 0; i < C.length; i++) { sum += C[i]; sum2 += C[i] * C[i]; }
  const n = C.length, mean = sum / n, variance = sum2 / n - mean * mean;
  if (variance > 500) return;                       // it has real colours already
  const span = (mx - mn) || 1;
  const waterline: Vec3 = [70, 52, 40], hull: Vec3 = [120, 82, 52], deck: Vec3 = [165, 128, 86], sail: Vec3 = [224, 220, 205];
  for (let i = 0, v = 0; i < P.length; i += 3, v += 3) {
    const h = (P[i + 1] - mn) / span;
    let col: Vec3;
    if (h < 0.12) col = waterline;
    else if (h < 0.34) col = mixv(waterline, hull, (h - 0.12) / 0.22);
    else if (h < 0.5) col = mixv(hull, deck, (h - 0.34) / 0.16);
    else col = mixv(deck, sail, Math.min(1, (h - 0.5) / 0.4));
    C[v] = col[0]; C[v + 1] = col[1]; C[v + 2] = col[2];
  }
}

// A simple recognizable sloop if the compiled asset is missing: hull + mast + sail.
function fallbackBoat(): RuntimeMesh {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3, rgb: [number, number, number]) => {
    const base = pos.length / 3;
    const n = normalize([
      (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
      (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
    ]);
    for (const v of [a, b, c]) { pos.push(v[0], v[1], v[2]); nor.push(n[0], n[1], n[2]); col.push(rgb[0], rgb[1], rgb[2]); }
    idx.push(base, base + 1, base + 2);
  };
  const hull: [number, number, number] = [140, 90, 55];
  const deck: [number, number, number] = [180, 140, 95];
  // hull: pointed bow (+Z), squared stern (-Z)
  const bow: Vec3 = [0, 0.5, 3], sternL: Vec3 = [-0.9, 0.5, -2.4], sternR: Vec3 = [0.9, 0.5, -2.4];
  const keelB: Vec3 = [0, -0.4, 2.2], keelS: Vec3 = [0, -0.2, -2.2];
  tri(bow, sternR, sternL, deck);
  tri(bow, keelB, sternR, hull); tri(bow, sternL, keelB, hull);
  tri(sternL, sternR, keelS, hull); tri(keelB, keelS, sternR, hull); tri(keelB, sternL, keelS, hull);
  // mast + sail
  const mastTop: Vec3 = [0, 5, 0.2];
  tri([0, 0.5, 0.4], mastTop, [0, 0.5, -1.8], [160, 120, 80]);
  const sail: [number, number, number] = [235, 235, 225];
  tri(mastTop, [0, 0.6, 2.2], [0, 0.6, -1.4], sail);
  return { positions: pos, normals: nor, colors: col, indices: idx };
}

// ---- ocean (camera-centred wave grid, reused buffers) ----
export class Ocean {
  positions: Float32Array; normals: Float32Array; colors: Uint8Array; indices: Uint32Array;
  constructor(public n: number, public spacing: number) {
    const v = n * n;
    this.positions = new Float32Array(v * 3);
    this.normals = new Float32Array(v * 3);
    this.colors = new Uint8Array(v * 3);
    const idx: number[] = [];
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const a = r * n + c, b = a + 1, d = a + n, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    this.indices = new Uint32Array(idx);
  }
  update(eye: Vec3, t: number, _light: LightEnv): void {
    const { n, spacing } = this;
    const half = (n - 1) / 2;
    const ox = Math.round(eye[0] / spacing) * spacing, oz = Math.round(eye[2] / spacing) * spacing;
    const deep: Vec3 = [16, 54, 88], shallow: Vec3 = [46, 118, 150], crest: Vec3 = [150, 195, 205];
    let k = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = ox + (c - half) * spacing, z = oz + (r - half) * spacing;
        const s = waveAt(x, z, t);
        this.positions[k] = x; this.positions[k + 1] = s.height; this.positions[k + 2] = z;
        const nx = -s.gx, nz = -s.gz;
        const nl = Math.hypot(nx, 1, nz) || 1;
        this.normals[k] = nx / nl; this.normals[k + 1] = 1 / nl; this.normals[k + 2] = nz / nl;
        // troughs deep, crests bright; lighting is applied by the renderer (Gouraud)
        const hn = clamp(s.height * 0.5 + 0.5, 0, 1);
        const col = hn < 0.5 ? mixv(deep, shallow, hn * 2) : mixv(shallow, crest, (hn - 0.5) * 2);
        this.colors[k] = col[0]; this.colors[k + 1] = col[1]; this.colors[k + 2] = col[2];
        k += 3;
      }
    }
  }
}
function mixv(a: Vec3, b: Vec3, t: number): Vec3 { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }

// ---- course buoys (simple bright markers) ----
export interface Buoy { x: number; z: number; color: [number, number, number]; }
function buoyMesh(b: Buoy, t: number): DrawMesh {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const y0 = waveAt(b.x, b.z, t).height;
  const top = y0 + 2.4, r = 0.5;
  const seg = 6;
  // a tall spike (cone) so it reads at distance
  const apex: Vec3 = [b.x, top, b.z];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p0: Vec3 = [b.x + Math.cos(a0) * r, y0, b.z + Math.sin(a0) * r];
    const p1: Vec3 = [b.x + Math.cos(a1) * r, y0, b.z + Math.sin(a1) * r];
    const base = pos.length / 3;
    const n = normalize([Math.cos((a0 + a1) / 2), 0.5, Math.sin((a0 + a1) / 2)]);
    for (const v of [apex, p1, p0]) { pos.push(v[0], v[1], v[2]); nor.push(n[0], n[1], n[2]); col.push(b.color[0], b.color[1], b.color[2]); }
    idx.push(base, base + 1, base + 2);
  }
  return { positions: pos, normals: nor, colors: col, indices: idx, flat: true };
}

// ---- chase camera with damped follow ----
export class ChaseCam {
  eye: Vec3 = [0, 6, -12]; yaw = 0; ready = false;
  // orbitYaw/orbitPitch are player-controlled offsets (arrow keys) around the boat.
  update(boat: BoatState, dt: number, orbitYaw = 0, orbitPitch = 0): { eye: Vec3; target: Vec3 } {
    const targetYaw = boat.yaw;
    if (!this.ready) { this.yaw = targetYaw; this.ready = true; }
    // shortest-arc yaw follow
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 3);
    const camYaw = this.yaw + orbitYaw;
    const back = 8.4, up = 3.2;
    const horiz = back * Math.cos(orbitPitch);
    const height = up + back * Math.sin(orbitPitch);
    const dir: Vec3 = [Math.sin(camYaw), 0, Math.cos(camYaw)];
    const bx = boat.x, bz = boat.z, by = boat.heave;
    const want: Vec3 = [bx - dir[0] * horiz, by + height, bz - dir[2] * horiz];
    const f = Math.min(1, dt * 6);
    this.eye = [lerp(this.eye[0], want[0], f), lerp(this.eye[1], want[1], f), lerp(this.eye[2], want[2], f)];
    return { eye: this.eye, target: [bx, by + 1.4, bz] };
  }
}

const SKY_TOP: Vec3 = [64, 120, 196];
const SKY_HORIZON: Vec3 = [196, 214, 232];
const LIGHT: LightEnv = {
  dir: normalize([-0.42, -0.82, -0.38]),
  ambient: 0.5, diffuse: 0.55,
  fog: { color: SKY_HORIZON, near: 28, far: 125 },
};

function paintSky(target: RasterTarget): void {
  const { width: W, height: H, rgb } = target;
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    // more sky up top, haze toward the horizon band ~55% down
    const tt = clamp(t / 0.6, 0, 1);
    const r = lerp(SKY_TOP[0], SKY_HORIZON[0], tt);
    const g = lerp(SKY_TOP[1], SKY_HORIZON[1], tt);
    const b = lerp(SKY_TOP[2], SKY_HORIZON[2], tt);
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 3; rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b; }
  }
  // soft sun glow, upper-left
  const sx = W * 0.26, sy = H * 0.16, sr = Math.min(W, H) * 0.10;
  for (let y = Math.max(0, sy - sr * 2 | 0); y < Math.min(H, sy + sr * 2); y++) {
    for (let x = Math.max(0, sx - sr * 2 | 0); x < Math.min(W, sx + sr * 2); x++) {
      const d = Math.hypot(x - sx, y - sy) / sr;
      const g = Math.max(0, 1 - d * d) * 0.9;
      if (g <= 0) continue;
      const o = (y * W + x) * 3;
      rgb[o] = lerp(rgb[o], 255, g); rgb[o + 1] = lerp(rgb[o + 1], 250, g); rgb[o + 2] = lerp(rgb[o + 2], 220, g);
    }
  }
}

export class SceneRenderer {
  ocean: Ocean;
  lods: RuntimeMesh[];
  texture?: Texture;
  boatWorldPos: Float32Array;
  boatWorldNor: Float32Array;
  cam = new ChaseCam();
  private ss?: RasterTarget;
  constructor(boat: BoatAsset, public buoys: Buoy[]) {
    this.ocean = new Ocean(48, 1.7);
    this.lods = boat.lods.length ? boat.lods : [fallbackBoat()];
    this.texture = boat.texture;
    const maxVerts = Math.max(...this.lods.map((l) => l.positions.length));
    this.boatWorldPos = new Float32Array(maxVerts);
    this.boatWorldNor = new Float32Array(maxVerts);
  }

  private pickLod(dist: number): RuntimeMesh {
    const n = this.lods.length;
    if (n === 1) return this.lods[0];
    const i = dist < 32 ? 0 : dist < 80 ? 1 : Math.min(n - 1, 2);
    return this.lods[Math.min(i, n - 1)];
  }

  /** Render the world into `out`. `ssaa` (1..3) supersamples for anti-aliasing.
   *  orbitYaw/orbitPitch orbit the camera around the boat (player arrow keys). */
  render(out: RasterTarget, boat: BoatState, wind: Wind, t: number, dt: number, fov: number, ssaa = 1, orbitYaw = 0, orbitPitch = 0): void {
    const s = ssaa > 1 ? ssaa : 1;
    let target = out;
    if (s > 1) {
      if (!this.ss || this.ss.width !== out.width * s || this.ss.height !== out.height * s) this.ss = new RasterTarget(out.width * s, out.height * s);
      target = this.ss;
    }
    paintSky(target);
    target.clearDepth();

    const { eye, target: look } = this.cam.update(boat, dt, orbitYaw, orbitPitch);
    const aspect = target.width / target.height;
    const view = lookAt(eye, look, [0, 1, 0]);
    const proj = perspective(fov, aspect, 0.12, 500);
    const vp = mul(proj, view);

    this.ocean.update(eye, t, LIGHT);
    renderMesh(target, vp, eye, LIGHT, {
      positions: this.ocean.positions, normals: this.ocean.normals, colors: this.ocean.colors, indices: this.ocean.indices,
    });

    for (const b of this.buoys) renderMesh(target, vp, eye, LIGHT, buoyMesh(b, t));

    // boat: model = T(pos, heave) * Ryaw * Rpitch * Rroll; LOD by camera distance
    const dist = Math.hypot(eye[0] - boat.x, eye[1] - boat.heave, eye[2] - boat.z);
    const lod = this.pickLod(dist);
    const model = mul(mul(mul(translation(boat.x, boat.heave + 0.15, boat.z), rotationY(boat.yaw)), rotationX(boat.pitch)), rotationZ(boat.roll));
    const P = lod.positions, N = lod.normals;
    for (let i = 0; i < P.length; i += 3) {
      const w = transform4(model, P[i], P[i + 1], P[i + 2]);
      this.boatWorldPos[i] = w[0]; this.boatWorldPos[i + 1] = w[1]; this.boatWorldPos[i + 2] = w[2];
      const d = normalize(transformDir(model, N[i], N[i + 1], N[i + 2]));
      this.boatWorldNor[i] = d[0]; this.boatWorldNor[i + 1] = d[1]; this.boatWorldNor[i + 2] = d[2];
    }
    renderMesh(target, vp, eye, LIGHT, {
      positions: this.boatWorldPos, normals: this.boatWorldNor, colors: lod.colors, indices: lod.indices,
      flat: true,
    });

    if (s > 1) downsample(target, out, s);
  }
}

// box-filter downsample src (w*s x h*s) into dst (w x h)
function downsample(src: RasterTarget, dst: RasterTarget, s: number): void {
  const W = dst.width, H = dst.height, sw = src.width, sr = src.rgb, dr = dst.rgb;
  const inv = 1 / (s * s);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      const bx = x * s, by = y * s;
      for (let dy = 0; dy < s; dy++) {
        let o = ((by + dy) * sw + bx) * 3;
        for (let dx = 0; dx < s; dx++) { r += sr[o]; g += sr[o + 1]; b += sr[o + 2]; o += 3; }
      }
      const d = (y * W + x) * 3; dr[d] = r * inv; dr[d + 1] = g * inv; dr[d + 2] = b * inv;
    }
  }
}
