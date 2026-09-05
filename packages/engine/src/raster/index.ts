// CPU software rasterizer -> packed RGB framebuffer + depth buffer.
// Supports per-vertex Gouraud/flat colour AND per-pixel perspective-correct texture
// mapping (bilinear). Knows nothing about SSH/ANSI/game. Right-handed, +Y up.
import { Mat4, Vec3, transform4, cross, sub } from '../math/index.js';

export class RasterTarget {
  readonly rgb: Uint8Array;
  readonly depth: Float32Array;
  constructor(public width: number, public height: number) {
    this.rgb = new Uint8Array(width * height * 3);
    this.depth = new Float32Array(width * height);
  }
  clearDepth(): void { this.depth.fill(Infinity); }
}

export interface FogParams { color: Vec3; near: number; far: number; }
export interface Texture { width: number; height: number; data: Uint8Array; } // RGB, row 0 = top

export interface DrawMesh {
  positions: Float32Array | number[];
  normals: Float32Array | number[];
  colors: Uint8Array | number[];
  indices: Uint32Array | Uint16Array | number[];
  uvs?: Float32Array | number[];
  texture?: Texture;
  flat?: boolean;
  unlit?: boolean;
  cull?: boolean; // backface-cull (opaque closed solids only; leave off for camera-facing cards)
}

export interface LightEnv { dir: Vec3; ambient: number; diffuse: number; fog: FogParams; }

interface Vtx { x: number; y: number; z: number; w: number; sh: number; cr: number; cg: number; cb: number; u: number; v: number; d: number; }
const mkv = (): Vtx => ({ x: 0, y: 0, z: 0, w: 0, sh: 0, cr: 0, cg: 0, cb: 0, u: 0, v: 0, d: 0 });
const NEAR_EPS = 1e-3;
// Screen-space winding of a front face: meshes flagged `cull` skip triangles
// whose screen-space area shares this sign (their back faces). Counter-clockwise
// indices project to negative area under this rasterizer's screen mapping.
const CULL_SIGN = 1;

function lerpV(a: Vtx, b: Vtx, t: number, o: Vtx): void {
  o.x = a.x + (b.x - a.x) * t; o.y = a.y + (b.y - a.y) * t; o.z = a.z + (b.z - a.z) * t; o.w = a.w + (b.w - a.w) * t;
  o.sh = a.sh + (b.sh - a.sh) * t; o.cr = a.cr + (b.cr - a.cr) * t; o.cg = a.cg + (b.cg - a.cg) * t; o.cb = a.cb + (b.cb - a.cb) * t;
  o.u = a.u + (b.u - a.u) * t; o.v = a.v + (b.v - a.v) * t; o.d = a.d + (b.d - a.d) * t;
}
function copyV(s: Vtx, o: Vtx): void { o.x = s.x; o.y = s.y; o.z = s.z; o.w = s.w; o.sh = s.sh; o.cr = s.cr; o.cg = s.cg; o.cb = s.cb; o.u = s.u; o.v = s.v; o.d = s.d; }
// Load one clip-space vertex (from the shared transform scratch) plus its colour/uv/shade.
function fillV(o: Vtx, ix: number, C: Uint8Array | number[], UV: Float32Array | number[] | undefined, sh: number, textured: boolean, unlit: boolean, flat: boolean, faceShade: number): void {
  o.x = VX[ix]; o.y = VY[ix]; o.z = VZ[ix]; o.w = VW[ix]; o.d = VW[ix];
  o.sh = unlit ? 1 : flat ? faceShade : sh;
  o.cr = C[ix * 3]; o.cg = C[ix * 3 + 1]; o.cb = C[ix * 3 + 2];
  if (textured) { o.u = UV![ix * 2]; o.v = UV![ix * 2 + 1]; }
}

// per-vertex clip-space scratch (grown as needed) so shared vertices transform ONCE
let VX = new Float32Array(0), VY = new Float32Array(0), VZ = new Float32Array(0), VW = new Float32Array(0), VSH = new Float32Array(0);
function ensureScratch(n: number): void {
  if (VX.length >= n) return;
  VX = new Float32Array(n); VY = new Float32Array(n); VZ = new Float32Array(n); VW = new Float32Array(n); VSH = new Float32Array(n);
}

export function renderMesh(target: RasterTarget, viewProj: Mat4, camPos: Vec3, light: LightEnv, mesh: DrawMesh): void {
  const { positions: P, normals: N, colors: C, indices: I, uvs: UV, texture: TEX } = mesh;
  const W = target.width, H = target.height, rgb = target.rgb, depth = target.depth;
  const { color: fogC, near: fogNear, far: fogFar } = light.fog;
  const fogSpan = Math.max(1e-3, fogFar - fogNear);
  const L0 = light.dir[0], L1 = light.dir[1], L2 = light.dir[2], amb = light.ambient, dif = light.diffuse;
  const textured = !!TEX && !!UV, flat = mesh.flat === true, unlit = mesh.unlit === true;
  const cull = mesh.cull === true ? CULL_SIGN : 0;
  const m = viewProj;

  // transform every unique vertex to clip space exactly once
  const nv = (P.length / 3) | 0;
  ensureScratch(nv);
  for (let v = 0, o = 0; v < nv; v++, o += 3) {
    const x = P[o], y = P[o + 1], z = P[o + 2];
    VX[v] = m[0] * x + m[4] * y + m[8] * z + m[12];
    VY[v] = m[1] * x + m[5] * y + m[9] * z + m[13];
    VZ[v] = m[2] * x + m[6] * y + m[10] * z + m[14];
    VW[v] = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!unlit && !flat) { const nd = -(N[o] * L0 + N[o + 1] * L1 + N[o + 2] * L2); VSH[v] = amb + dif * (nd > 0 ? nd : 0); }
  }

  const inV = [mkv(), mkv(), mkv()], outV = [mkv(), mkv(), mkv(), mkv()];
  for (let t = 0; t < I.length; t += 3) {
    const i0 = I[t], i1 = I[t + 1], i2 = I[t + 2];
    let faceShade = 1;
    if (!unlit && flat) {
      const ax = P[i0 * 3], ay = P[i0 * 3 + 1], az = P[i0 * 3 + 2];
      const fn = cross(sub([P[i1 * 3], P[i1 * 3 + 1], P[i1 * 3 + 2]], [ax, ay, az]), sub([P[i2 * 3], P[i2 * 3 + 1], P[i2 * 3 + 2]], [ax, ay, az]));
      const fl = Math.hypot(fn[0], fn[1], fn[2]) || 1;
      faceShade = amb + dif * Math.abs((fn[0] * L0 + fn[1] * L1 + fn[2] * L2) / fl);
    }
    const w0v = VW[i0], w1v = VW[i1], w2v = VW[i2];
    fillV(inV[0], i0, C, UV, VSH[i0], textured, unlit, flat, faceShade);
    fillV(inV[1], i1, C, UV, VSH[i1], textured, unlit, flat, faceShade);
    fillV(inV[2], i2, C, UV, VSH[i2], textured, unlit, flat, faceShade);

    // Common case: whole triangle in front of the near plane → skip Sutherland-Hodgman
    // (and its per-vertex copies) entirely and rasterize the source vertices directly.
    if (w0v >= NEAR_EPS && w1v >= NEAR_EPS && w2v >= NEAR_EPS) {
      // Backface cull in clip space (divide-free): the sign of the screen-space area
      // equals -sign of this 3x3 clip determinant, so we can drop back faces before
      // paying rasterTri's three perspective divides.
      if (cull !== 0) {
        const x0 = VX[i0], y0 = VY[i0], x1 = VX[i1], y1 = VY[i1], x2 = VX[i2], y2 = VY[i2];
        const det = x0 * (y1 * w2v - y2 * w1v) - y0 * (x1 * w2v - x2 * w1v) + w0v * (x1 * y2 - x2 * y1);
        if (det * cull < 0) continue;
      }
      rasterTri(inV[0], inV[1], inV[2], W, H, rgb, depth, fogC, fogNear, fogSpan, textured ? TEX! : null, 0);
      continue;
    }
    if (w0v < NEAR_EPS && w1v < NEAR_EPS && w2v < NEAR_EPS) continue; // wholly behind

    // near-plane clip (w >= NEAR_EPS), Sutherland-Hodgman
    let nOut = 0;
    for (let k = 0; k < 3; k++) {
      const cur = inV[k], prev = inV[(k + 2) % 3];
      const curIn = cur.w >= NEAR_EPS, prevIn = prev.w >= NEAR_EPS;
      if (curIn) {
        if (!prevIn) lerpV(prev, cur, (NEAR_EPS - prev.w) / (cur.w - prev.w), outV[nOut++]);
        copyV(cur, outV[nOut++]);
      } else if (prevIn) {
        lerpV(prev, cur, (NEAR_EPS - prev.w) / (cur.w - prev.w), outV[nOut++]);
      }
    }
    if (nOut < 3) continue;
    for (let f = 1; f < nOut - 1; f++) rasterTri(outV[0], outV[f], outV[f + 1], W, H, rgb, depth, fogC, fogNear, fogSpan, textured ? TEX! : null, cull);
  }
}

function rasterTri(v0: Vtx, v1: Vtx, v2: Vtx, W: number, H: number, rgb: Uint8Array, depth: Float32Array, fogC: Vec3, fogNear: number, fogSpan: number, tex: Texture | null, cull: number): void {
  const iw0 = 1 / v0.w, iw1 = 1 / v1.w, iw2 = 1 / v2.w;
  const sx0 = (v0.x * iw0 * 0.5 + 0.5) * W, sy0 = (1 - (v0.y * iw0 * 0.5 + 0.5)) * H, sz0 = v0.z * iw0 * 0.5 + 0.5;
  const sx1 = (v1.x * iw1 * 0.5 + 0.5) * W, sy1 = (1 - (v1.y * iw1 * 0.5 + 0.5)) * H, sz1 = v1.z * iw1 * 0.5 + 0.5;
  const sx2 = (v2.x * iw2 * 0.5 + 0.5) * W, sy2 = (1 - (v2.y * iw2 * 0.5 + 0.5)) * H, sz2 = v2.z * iw2 * 0.5 + 0.5;

  const area = (sx1 - sx0) * (sy2 - sy0) - (sy1 - sy0) * (sx2 - sx0);
  if (cull !== 0 && area * cull > 0) return; // backface: front faces have area sign opposite to CULL_SIGN
  if (Math.abs(area) < 1e-7) return;
  const inv = 1 / area;

  // perspective-correct varyings (attr * invW), interpolated then divided by interp(invW)
  const shw0 = v0.sh * iw0, shw1 = v1.sh * iw1, shw2 = v2.sh * iw2;
  const crw0 = v0.cr * iw0, crw1 = v1.cr * iw1, crw2 = v2.cr * iw2;
  const cgw0 = v0.cg * iw0, cgw1 = v1.cg * iw1, cgw2 = v2.cg * iw2;
  const cbw0 = v0.cb * iw0, cbw1 = v1.cb * iw1, cbw2 = v2.cb * iw2;
  const uw0 = v0.u * iw0, uw1 = v1.u * iw1, uw2 = v2.u * iw2;
  const vw0 = v0.v * iw0, vw1 = v1.v * iw1, vw2 = v2.v * iw2;
  const dw0 = v0.d * iw0, dw1 = v1.d * iw1, dw2 = v2.d * iw2;

  let minX = Math.max(0, Math.floor(Math.min(sx0, sx1, sx2)));
  let maxX = Math.min(W, Math.ceil(Math.max(sx0, sx1, sx2)));
  let minY = Math.max(0, Math.floor(Math.min(sy0, sy1, sy2)));
  let maxY = Math.min(H, Math.ceil(Math.max(sy0, sy1, sy2)));
  if (minX >= maxX || minY >= maxY) return;
  const tw = tex ? tex.width : 0, th = tex ? tex.height : 0, td = tex ? tex.data : null;

  for (let y = minY; y < maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x < maxX; x++) {
      const px = x + 0.5;
      const w0 = ((sx1 - px) * (sy2 - py) - (sy1 - py) * (sx2 - px)) * inv;
      if (w0 < 0) continue;
      const w1 = ((sx2 - px) * (sy0 - py) - (sy2 - py) * (sx0 - px)) * inv;
      if (w1 < 0) continue;
      const w2 = 1 - w0 - w1;
      if (w2 < 0) continue;

      const z = w0 * sz0 + w1 * sz1 + w2 * sz2;
      const di = y * W + x;
      if (z >= depth[di]) continue;

      const iw = w0 * iw0 + w1 * iw1 + w2 * iw2;
      const recip = 1 / iw;
      const sh = (w0 * shw0 + w1 * shw1 + w2 * shw2) * recip;
      let r: number, g: number, b: number;
      if (td) {
        let u = (w0 * uw0 + w1 * uw1 + w2 * uw2) * recip;
        let v = (w0 * vw0 + w1 * vw1 + w2 * vw2) * recip;
        u -= Math.floor(u); v -= Math.floor(v);
        const fx = u * (tw - 1), fy = v * (th - 1);
        const x0 = fx | 0, y0 = fy | 0, x1 = x0 + 1 < tw ? x0 + 1 : x0, y1 = y0 + 1 < th ? y0 + 1 : y0;
        const dx = fx - x0, dy = fy - y0;
        const o00 = (y0 * tw + x0) * 3, o10 = (y0 * tw + x1) * 3, o01 = (y1 * tw + x0) * 3, o11 = (y1 * tw + x1) * 3;
        const a = (1 - dx) * (1 - dy), bb = dx * (1 - dy), c = (1 - dx) * dy, dd = dx * dy;
        r = td[o00] * a + td[o10] * bb + td[o01] * c + td[o11] * dd;
        g = td[o00 + 1] * a + td[o10 + 1] * bb + td[o01 + 1] * c + td[o11 + 1] * dd;
        b = td[o00 + 2] * a + td[o10 + 2] * bb + td[o01 + 2] * c + td[o11 + 2] * dd;
      } else {
        r = (w0 * crw0 + w1 * crw1 + w2 * crw2) * recip;
        g = (w0 * cgw0 + w1 * cgw1 + w2 * cgw2) * recip;
        b = (w0 * cbw0 + w1 * cbw1 + w2 * cbw2) * recip;
      }
      depth[di] = z;
      r *= sh; g *= sh; b *= sh;
      const camDist = (w0 * dw0 + w1 * dw1 + w2 * dw2) * recip;
      let fog = (camDist - fogNear) / fogSpan;
      if (fog > 0) { if (fog > 1) fog = 1; r += (fogC[0] - r) * fog; g += (fogC[1] - g) * fog; b += (fogC[2] - b) * fog; }
      const o = di * 3;
      rgb[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      rgb[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      rgb[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
}
