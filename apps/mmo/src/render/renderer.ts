// WorldRenderer: composes one frame of the shared world — sky, terrain chunks,
// grass, ground shadows, props, agents, particles — into a RasterTarget. Pure
// function of (world state, camera, time), so it runs identically on the main
// thread or on any render worker.
import {
  type Mat4,
  type Vec3,
  type LightEnv,
  type Texture,
  RasterTarget,
  renderMesh,
  mul,
  lookAt,
  perspective,
  translation,
  rotationY,
  scaling,
  normalize,
  Frustum,
  selectLod,
} from '@tellus/engine';
import { loadModel, type Mesh, type Model } from '../world/mesh.js';
import type { World } from '../world/world.js';
import { Grass } from '../nature/grass.js';
import { sway, windState } from '../nature/wind.js';
import { dayState, type DayState } from '../nature/daynight.js';
import { Particles } from '../nature/particles.js';
import { makeStars, paintSky } from './sky.js';
import { castShadows } from './shadows.js';

const clampf = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const ORIGIN: Vec3 = [0, 0, 0];

interface WindCfg {
  sx: number;
  sz: number;
  baseY: number;
  height: number;
}

// bright clear afternoon fallback: soft blue sky, warm hazy horizon, high sun so
// nothing falls into muddy shadow (dayState supplies the live palette per frame).
const SKY_HORIZON: Vec3 = [226, 216, 190];
const LIGHT: LightEnv = {
  dir: normalize([-0.45, -0.82, -0.35]),
  ambient: 0.66,
  diffuse: 0.62,
  fog: { color: SKY_HORIZON, near: 65, far: 165 },
};
export const FOV = 1.1;
/** Colour quantization step for terminal cells — one value shared by every render path. */
export const COLOR_QUANT = 12;
const FOG_FAR = 165;

// LOD0 is now the ORIGINAL source geometry (~27k tris) — spend it only up close,
// where the eye lives; the clustered LODs take over where terminal cells can no
// longer resolve the difference. Tunable via env.
const LOD0_D = Number(process.env.LOD0 ?? 24);
const LOD1_D = Number(process.env.LOD1 ?? 70);

export interface NameTag {
  id: number;
  col: number;
  row: number;
  name: string;
  self: boolean;
}

interface Inst {
  id: string;
  mat: Mat4;
  yaw: number;
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  baseY: number;
  floating: boolean; // has an explicit altitude (balloons) — keep full LOD, no shadow
  treeH: number; // >0 = sways in the wind (foliage)
}

function modelRadius(m: Model): number {
  const P = m.lods[0]!.positions;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const n = P.length / 3;
  for (let i = 0; i < P.length; i += 3) {
    cx += P[i]!;
    cy += P[i + 1]!;
    cz += P[i + 2]!;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let r = 0;
  for (let i = 0; i < P.length; i += 3) {
    const d = Math.hypot(P[i]! - cx, P[i + 1]! - cy, P[i + 2]! - cz);
    if (d > r) r = d;
  }
  return r;
}

export class WorldRenderer {
  private readonly models = new Map<string, Model>();
  private readonly instances: Inst[] = [];
  private readonly sp: Float32Array;
  private readonly sn: Float32Array;
  private readonly grass: Grass;
  private readonly treeIds: Set<string>;
  start = Date.now(); // wall-clock origin for the day cycle (settable for previews)
  private frameLight: LightEnv = LIGHT;
  private readonly stars = makeStars();
  private readonly particles = new Particles();

  constructor(world: World) {
    this.treeIds = new Set(world.catalog.filter((c) => c.kind === 'tree').map((c) => c.id));
    const ids = new Set<string>();
    for (const p of world.props) ids.add(p.id);
    for (const a of world.agents()) ids.add(a.mesh);
    for (const id of world.heroPool) ids.add(id); // any player can wear any hero

    let maxVerts = 3;
    for (const id of ids) {
      try {
        const m = loadModel(id);
        if (m.lods.length) {
          this.models.set(id, m);
          maxVerts = Math.max(maxVerts, m.lods[0]!.positions.length);
        }
      } catch {
        /* skip a bad mesh */
      }
    }
    this.sp = new Float32Array(maxVerts);
    this.sn = new Float32Array(maxVerts);

    const radii = new Map<string, number>();
    for (const [id, m] of this.models) radii.set(id, modelRadius(m));

    for (const p of world.props) {
      if (!this.models.has(p.id)) continue;
      const yy = p.y ?? world.groundAt(p.x, p.z);
      const mat = mul(mul(translation(p.x, yy, p.z), rotationY(p.yaw)), scaling(p.scale, p.scale, p.scale));
      const r = (radii.get(p.id) ?? 1) * p.scale;
      const treeH = this.treeIds.has(p.id) ? r * 1.5 : 0;
      this.instances.push({ id: p.id, mat, yaw: p.yaw, cx: p.x, cy: yy + r * 0.5, cz: p.z, radius: r + 1, baseY: yy, floating: p.y !== undefined, treeH });
    }

    this.grass = new Grass(world);
  }

  render(target: RasterTarget, world: World, viewerId: number, eye: Vec3, look: Vec3, cols: number, rows: number, tSec?: number): NameTag[] {
    const t = tSec ?? (Date.now() - this.start) / 1000;
    const day = dayState(t);
    this.frameLight = day.light;

    const aspect = target.width / target.height;
    const vp = mul(perspective(FOV, aspect, 0.1, 340), lookAt(eye, look, [0, 1, 0]));
    const fr = Frustum.fromViewProj(vp);

    paintSky(target, day, vp, eye, this.stars);
    target.clearDepth();

    for (const ch of world.terrain) {
      if (fr.culls(ch.cx, ch.cy, ch.cz, ch.radius)) continue;
      renderMesh(target, vp, eye, day.light, ch.mesh);
    }
    this.grass.render(target, vp, eye, look, day.light, t, world);
    // ground shadows: cast now, while only terrain + grass are in the depth buffer,
    // so objects sit planted in the world. Props draw over them next.
    castShadows(target, vp, fr, day, world, this.instances);
    const wstate = windState(t);

    // props: frustum-cull (whole bounding sphere off-screen → skip), fog-cull, LOD by distance
    for (const inst of this.instances) {
      if (fr.culls(inst.cx, inst.cy, inst.cz, inst.radius)) continue;
      const dx = inst.cx - eye[0];
      const dy = inst.cy - eye[1];
      const dz = inst.cz - eye[2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist > FOG_FAR + inst.radius) continue;
      const m = this.models.get(inst.id)!;
      // floating props (balloons) are skyline silhouettes — keep them full-detail
      const lod = inst.floating ? m.lods[0]! : selectLod(m.lods, dist, LOD0_D, LOD1_D);
      if (inst.treeH > 0 && dist < 58) {
        const s = sway(inst.cx, inst.cz, wstate, t, 1, 2.2);
        this.drawSway(target, vp, eye, lod, inst.mat, inst.yaw, m.texture, { sx: s.x, sz: s.z, baseY: inst.baseY, height: inst.treeH });
      } else {
        this.drawFast(target, vp, lod, inst.mat, inst.yaw, m.texture, day.light);
      }
    }

    // agents: players + wandering creatures
    const tags: NameTag[] = [];
    for (const a of world.agents()) {
      const m = this.models.get(a.mesh);
      if (!m) continue;
      const gy = world.groundAt(a.x, a.z);
      if (fr.culls(a.x, gy + 1, a.z, 2.5)) continue;
      const dist = Math.hypot(a.x - eye[0], gy - eye[1], a.z - eye[2]);
      if (dist > FOG_FAR) continue;
      const lod = selectLod(m.lods, dist, LOD0_D, LOD1_D);
      this.drawFast(target, vp, lod, mul(translation(a.x, gy, a.z), rotationY(a.yaw)), a.yaw, m.texture, day.light);
      if (a.isPlayer) {
        const tag = project(vp, a.x, gy + 1.7, a.z, cols, rows);
        if (tag) tags.push({ ...tag, id: a.id, name: a.name, self: a.id === viewerId });
      }
    }

    this.particles.render(target, vp, eye, day, t, world);
    this.lampGlow(target, vp, fr, eye, day, world);
    return tags;
  }

  // Street lanterns after dusk: a warm additive glow splatted around each lamp
  // post — depth-aware enough (screen-radius scaled by distance) to read as pools
  // of light along the avenues. This is what makes the city feel alive at night.
  private lampGlow(target: RasterTarget, vp: Mat4, fr: Frustum, eye: Vec3, day: DayState, world: World): void {
    const on = Math.min(1, Math.max(0, (day.night - 0.08) / 0.3)); // fade in through dusk
    if (on <= 0.02) return;
    const { width: W, height: H, rgb } = target;
    for (const l of world.lampPosts) {
      const gy = world.groundAt(l.x, l.z) + 1.15; // the flame sits atop the post
      if (fr.culls(l.x, gy, l.z, 2)) continue;
      const dx = l.x - eye[0];
      const dz = l.z - eye[2];
      const dist = Math.hypot(dx, dz);
      if (dist > 90) continue;
      const cw = vp[3] * l.x + vp[7] * gy + vp[11] * l.z + vp[15];
      if (cw <= 0.05) continue;
      const sx = (vp[0] * l.x + vp[4] * gy + vp[8] * l.z + vp[12]) / cw;
      const sy = (vp[1] * l.x + vp[5] * gy + vp[9] * l.z + vp[13]) / cw;
      const px = (sx * 0.5 + 0.5) * W;
      const py = (1 - (sy * 0.5 + 0.5)) * H;
      const r = Math.max(2, (W * 0.55) / Math.max(3, dist)); // shrinks with distance
      const x0 = Math.max(0, (px - r) | 0), x1 = Math.min(W, (px + r + 1) | 0);
      const y0 = Math.max(0, (py - r * 0.8) | 0), y1 = Math.min(H, (py + r * 1.3) | 0);
      const ir = 1 / r;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const ndx = (x - px) * ir;
          const ndy = (y - py) * ir;
          const d2 = ndx * ndx + ndy * ndy;
          if (d2 >= 1) continue;
          const g = (1 - d2) * (1 - d2) * on;
          const o = (y * W + x) * 3;
          rgb[o] = Math.min(255, rgb[o]! + 190 * g);
          rgb[o + 1] = Math.min(255, rgb[o + 1]! + 140 * g);
          rgb[o + 2] = Math.min(255, rgb[o + 2]! + 58 * g);
        }
      }
    }
  }

  // Fast path (no sway): fold the model matrix into the view-projection so each
  // vertex is transformed ONCE, and rotate the light into model space so normals
  // need no per-vertex transform at all. Local mesh in, one matrix multiply out.
  private drawFast(target: RasterTarget, vp: Mat4, lod: Mesh, mat: Mat4, yaw: number, texture: Texture | undefined, light: LightEnv): void {
    const mvp = mul(vp, mat);
    const L = light.dir;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const modelLight: LightEnv = { ...light, dir: [c * L[0] - s * L[2], L[1], s * L[0] + c * L[2]] };
    renderMesh(target, mvp, ORIGIN, modelLight, {
      positions: lod.positions,
      normals: lod.normals,
      colors: lod.colors,
      indices: lod.indices,
      uvs: lod.uvs,
      texture,
    });
  }

  // Sway path (foliage): must live in world space so the wind can bend it.
  // Inlined + allocation-free: the model matrix is translate·rotateY·uniformScale,
  // so positions fold with one dot per row and unit normals just rotate by yaw
  // (no matvec, no sqrt, no per-vertex array allocation).
  private drawSway(target: RasterTarget, vp: Mat4, eye: Vec3, lod: Mesh, mat: Mat4, yaw: number, texture: Texture | undefined, wind: WindCfg): void {
    const P = lod.positions;
    const N = lod.normals;
    const n = P.length;
    const m0 = mat[0]!, m4 = mat[4]!, m8 = mat[8]!, m12 = mat[12]!;
    const m1 = mat[1]!, m5 = mat[5]!, m9 = mat[9]!, m13 = mat[13]!;
    const m2 = mat[2]!, m6 = mat[6]!, m10 = mat[10]!, m14 = mat[14]!;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (let i = 0; i < n; i += 3) {
      const px = P[i]!, py = P[i + 1]!, pz = P[i + 2]!;
      this.sp[i] = m0 * px + m4 * py + m8 * pz + m12;
      this.sp[i + 1] = m1 * px + m5 * py + m9 * pz + m13;
      this.sp[i + 2] = m2 * px + m6 * py + m10 * pz + m14;
      const nx = N[i]!, nz = N[i + 2]!;
      this.sn[i] = cy * nx + sy * nz;
      this.sn[i + 1] = N[i + 1]!;
      this.sn[i + 2] = cy * nz - sy * nx;
    }
    // foliage sway: a per-tree offset weighted by height² (base pinned) — no per-vertex trig
    for (let i = 0; i < n; i += 3) {
      const hf = clampf((this.sp[i + 1]! - wind.baseY) / wind.height, 0, 1);
      if (hf <= 0.03) continue;
      const f = hf * hf;
      this.sp[i] += wind.sx * f;
      this.sp[i + 2] += wind.sz * f;
    }
    renderMesh(target, vp, eye, this.frameLight, {
      positions: this.sp.subarray(0, n),
      normals: this.sn.subarray(0, n),
      colors: lod.colors,
      indices: lod.indices,
      uvs: lod.uvs, // per-pixel textured when a texture is supplied
      texture,
    });
  }
}

/** Project a world point to a terminal cell (for name tags); null when off-screen. */
function project(vp: Mat4, x: number, y: number, z: number, cols: number, rows: number): { col: number; row: number } | null {
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 0.01) return null;
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) return null;
  return { col: Math.round((ndcX * 0.5 + 0.5) * cols), row: Math.round((1 - (ndcY * 0.5 + 0.5)) * rows) };
}
