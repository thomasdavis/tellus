#!/usr/bin/env node
// compile-glb.mjs
// Self-contained GLB -> compact runtime mesh JSON compiler with baked texture
// colors and multiple LODs.
//
// Pure Node built-ins for GLB parsing / geometry; texture decode uses the

//
// Pipeline:
//   1. Parse GLB (header + JSON chunk + BIN chunk), parse glTF JSON.
//   2. Decode each material's baseColor image (WebP via EXT_texture_webp) to raw
//      RGB once, building a per-material color sampler (UV -> RGB).
//   3. Walk the node tree from the scene, accumulating world matrices (TRS or
//      matrix). Dequantize (KHR_mesh_quantization: honor accessor `normalized`),
//      transform POSITION by world and NORMAL by inverse-transpose, sample the
//      baked texture color per original vertex from its UV, merge all primitives.
//   4. Align the hull's long horizontal axis to +Z via 2D PCA (rotation about Y
//      keeps Y-up), bow -> +Z.
//   5. Build THREE LODs via grid vertex-clustering decimation (averaging baked
//      color + position + normal per cluster). One shared recenter+scale
//      transform (derived from LOD0) is applied to every LOD so they line up:
//      Y-up, bow +Z, min-Y ~= 0, longest horizontal extent == 6.0 m.
//   6. Validate + emit boat.mesh.json with a `lods` array.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const INPUT_PATH = process.argv[2];
const OUT_DIR = process.argv[3];
const ID = process.argv[4] || 'model';
const TARGET_HORIZONTAL_SIZE = parseFloat(process.argv[5] || '2.0'); // longest horizontal extent, m
const ALIGN = process.argv.includes('--align');
const OUTPUT_PATH = path.join(OUT_DIR || '.', ID + '.mesh.json');
const TEX_OUTPUT_PATH = path.join(OUT_DIR || '.', ID + '.tex.bin');
const DEFAULT_COLOR = [170, 170, 170];
if (!INPUT_PATH || !OUT_DIR) { console.error('usage: compile-glb.mjs <input.glb> <outDir> <id> [size] [--align]'); process.exit(2); }

// LOD triangle targets [min, max]; the compiler searches grid resolution to land
// each LOD inside its range.
const LOD_TARGETS = [
  { name: 'LOD0', min: 7000, max: 14000 },
  { name: 'LOD1', min: 2200, max: 4200 },
  { name: 'LOD2', min: 600, max: 1300 },
];

// ---------------------------------------------------------------------------
// glTF constants
// ---------------------------------------------------------------------------
const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// ---------------------------------------------------------------------------
// Matrix / vector math (mat4 stored column-major, matching glTF)
// ---------------------------------------------------------------------------
function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// result = a * b   (both column-major)
function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

// Compose translation (v3) * rotation (quat xyzw) * scale (v3)  -> column-major mat4
function composeTRS(t, q, s) {
  const [x, y, z, w] = q;
  const [sx, sy, sz] = s;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// Build the 3x3 inverse-transpose (cofactor / det) as row-major [9], for normals.
function normalMatrix(m) {
  const a00 = m[0], a01 = m[4], a02 = m[8];
  const a10 = m[1], a11 = m[5], a12 = m[9];
  const a20 = m[2], a21 = m[6], a22 = m[10];
  const c00 = a11 * a22 - a12 * a21;
  const c01 = -(a10 * a22 - a12 * a20);
  const c02 = a10 * a21 - a11 * a20;
  const c10 = -(a01 * a22 - a02 * a21);
  const c11 = a00 * a22 - a02 * a20;
  const c12 = -(a00 * a21 - a01 * a20);
  const c20 = a01 * a12 - a02 * a11;
  const c21 = -(a00 * a12 - a02 * a10);
  const c22 = a00 * a11 - a01 * a10;
  let det = a00 * c00 + a01 * c01 + a02 * c02;
  if (!isFinite(det) || Math.abs(det) < 1e-12) det = 1;
  const inv = 1 / det;
  return [
    c00 * inv, c01 * inv, c02 * inv,
    c10 * inv, c11 * inv, c12 * inv,
    c20 * inv, c21 * inv, c22 * inv,
  ];
}

function transformNormal(nm, x, y, z) {
  const rx = nm[0] * x + nm[1] * y + nm[2] * z;
  const ry = nm[3] * x + nm[4] * y + nm[5] * z;
  const rz = nm[6] * x + nm[7] * y + nm[8] * z;
  const len = Math.hypot(rx, ry, rz) || 1;
  return [rx / len, ry / len, rz / len];
}

// ---------------------------------------------------------------------------
// GLB parsing
// ---------------------------------------------------------------------------
function parseGLB(buffer) {
  if (buffer.length < 12) throw new Error('file too small to be a GLB');
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('bad GLB magic (not "glTF")');
  const version = buffer.readUInt32LE(4);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  const totalLength = buffer.readUInt32LE(8);

  let json = null;
  let bin = null;
  let offset = 12;
  while (offset + 8 <= totalLength && offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (chunkType === 0x4e4f534a) { // 'JSON'
      json = JSON.parse(buffer.slice(dataStart, dataEnd).toString('utf8'));
    } else if (chunkType === 0x004e4942) { // 'BIN\0'
      bin = Buffer.from(buffer.slice(dataStart, dataEnd));
    }
    offset = dataEnd;
  }
  if (!json) throw new Error('no JSON chunk found');
  return { json, bin };
}

// Read an accessor into a flat JS number array (respecting bufferView byteStride).
function makeAccessorReader(json, bin) {
  return function readAccessor(idx) {
    const a = json.accessors[idx];
    if (a.bufferView === undefined) {
      const nc = TYPE_COMPONENTS[a.type];
      return new Array(a.count * nc).fill(0);
    }
    const bv = json.bufferViews[a.bufferView];
    const nc = TYPE_COMPONENTS[a.type];
    const compSize = COMPONENT_SIZE[a.componentType];
    if (!compSize) throw new Error(`unsupported componentType ${a.componentType}`);
    const elemSize = nc * compSize;
    const stride = bv.byteStride || elemSize;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const count = a.count;
    const out = new Array(count * nc);
    for (let i = 0; i < count; i++) {
      const elemOff = base + i * stride;
      for (let c = 0; c < nc; c++) {
        const o = elemOff + c * compSize;
        let v;
        switch (a.componentType) {
          case 5126: v = bin.readFloatLE(o); break;
          case 5123: v = bin.readUInt16LE(o); break;
          case 5125: v = bin.readUInt32LE(o); break;
          case 5121: v = bin.readUInt8(o); break;
          case 5122: v = bin.readInt16LE(o); break;
          case 5120: v = bin.readInt8(o); break;
          default: throw new Error(`unsupported componentType ${a.componentType}`);
        }
        // Honor the normalized flag (KHR_mesh_quantization stores integers here).
        if (a.normalized) {
          switch (a.componentType) {
            case 5121: v = v / 255; break;             // UNSIGNED_BYTE -> [0,1]
            case 5123: v = v / 65535; break;           // UNSIGNED_SHORT -> [0,1]
            case 5120: v = Math.max(v / 127, -1); break;   // BYTE -> [-1,1]
            case 5122: v = Math.max(v / 32767, -1); break; // SHORT -> [-1,1]
          }
        }
        out[i * nc + c] = v;
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Texture: decode baseColor image + build per-material color sampler
// ---------------------------------------------------------------------------
// Apply KHR_texture_transform to a UV (scale, then rotation, then offset).
function applyTextureTransform(u, v, tt) {
  if (!tt) return [u, v];
  const [su, sv] = tt.scale || [1, 1];
  const rot = tt.rotation || 0;
  const [ou, ov] = tt.offset || [0, 0];
  let x = u * su, y = v * sv;
  if (rot) {
    const c = Math.cos(rot), s = Math.sin(rot);
    // glTF KHR_texture_transform rotation matrix
    const rx = c * x + s * y;
    const ry = -s * x + c * y;
    x = rx; y = ry;
  }
  return [x + ou, y + ov];
}

function wrap01(x) { return ((x % 1) + 1) % 1; }

// Bilinear sample from a decoded raw texture { data, width, height, channels }.
// Convention: glTF UV (0,0) is top-left of the image, image row 0 is the top.
function sampleTexBilinear(tex, u, v, flipV) {
  const w = tex.width, h = tex.height, ch = tex.channels, d = tex.data;
  let uu = wrap01(u);
  let vv = wrap01(flipV ? 1 - v : v);
  const fx = uu * (w - 1);
  const fy = vv * (h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * w + x0) * ch;
  const i10 = (y0 * w + x1) * ch;
  const i01 = (y1 * w + x0) * ch;
  const i11 = (y1 * w + x1) * ch;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = d[i00 + c] * (1 - tx) + d[i10 + c] * tx;
    const b = d[i01 + c] * (1 - tx) + d[i11 + c] * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

// Resolve the image bufferView for a texture, honoring EXT_texture_webp.
function textureImageIndex(json, textureIndex) {
  const tex = json.textures?.[textureIndex];
  if (!tex) return undefined;
  const webp = tex.extensions?.EXT_texture_webp;
  if (webp && webp.source !== undefined) return webp.source;
  return tex.source;
}

// Build a Map materialIndex -> sampler. A sampler is
//   { tex, transform, factor, flipV }  when a baseColor texture exists, else
//   { constColor:[r,g,b] }.
async function buildMaterialSamplers(json, bin, opts) {
  const samplers = new Map();
  const materials = json.materials || [];
  // cache decoded images by image index
  const decoded = new Map();
  async function decodeImage(imageIndex) {
    if (decoded.has(imageIndex)) return decoded.get(imageIndex);
    const img = json.images[imageIndex];
    if (img.bufferView === undefined) throw new Error(`image ${imageIndex} has no bufferView (URI images unsupported)`);
    const bv = json.bufferViews[img.bufferView];
    const bytes = bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tex = { data, width: info.width, height: info.height, channels: info.channels };
    decoded.set(imageIndex, tex);
    return tex;
  }

  for (let m = 0; m < materials.length; m++) {
    const mat = materials[m];
    const pbr = mat.pbrMetallicRoughness || {};
    const bct = pbr.baseColorTexture;
    const factor = pbr.baseColorFactor
      ? [pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]]
      : [1, 1, 1];
    if (bct && bct.index !== undefined) {
      const imageIndex = textureImageIndex(json, bct.index);
      if (imageIndex !== undefined) {
        const tex = await decodeImage(imageIndex);
        const transform = bct.extensions?.KHR_texture_transform || null;
        samplers.set(m, { tex, transform, factor, flipV: opts.flipV, texCoord: bct.texCoord || 0 });
        continue;
      }
    }
    // no texture: constant color from factor (or default gray)
    const c = pbr.baseColorFactor
      ? [Math.round(factor[0] * 255), Math.round(factor[1] * 255), Math.round(factor[2] * 255)]
      : DEFAULT_COLOR.slice();
    samplers.set(m, { constColor: c });
  }
  return samplers;
}

// ---------------------------------------------------------------------------
// Scene walk + merge (with baked texture colors)
// ---------------------------------------------------------------------------
function nodeLocalMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return composeTRS(t, q, s);
}

function compileMerged(json, bin, samplers) {
  const readAccessor = makeAccessorReader(json, bin);

  const gPositions = [];
  const gNormals = [];
  const gColors = [];
  const gUvs = [];
  const gIndices = [];
  let vertsMissingNormals = 0;
  let vertsMissingUV = 0;
  let primCount = 0;
  let skippedNonTri = 0;

  function samplerColor(sampler, u, v) {
    if (!sampler) return DEFAULT_COLOR;
    if (sampler.constColor) return sampler.constColor;
    let uu = u, vv = v;
    if (sampler.transform) [uu, vv] = applyTextureTransform(u, v, sampler.transform);
    const rgb = sampleTexBilinear(sampler.tex, uu, vv, sampler.flipV);
    return [
      Math.max(0, Math.min(255, Math.round(rgb[0] * sampler.factor[0]))),
      Math.max(0, Math.min(255, Math.round(rgb[1] * sampler.factor[1]))),
      Math.max(0, Math.min(255, Math.round(rgb[2] * sampler.factor[2]))),
    ];
  }

  function processPrimitive(prim, world, nmat) {
    const mode = prim.mode === undefined ? 4 : prim.mode;
    if (mode !== 4) { skippedNonTri++; return; } // TRIANGLES only
    if (!prim.attributes || prim.attributes.POSITION === undefined) return;

    const posRaw = readAccessor(prim.attributes.POSITION);
    const vCount = posRaw.length / 3;
    const hasNormals = prim.attributes.NORMAL !== undefined;
    const normRaw = hasNormals ? readAccessor(prim.attributes.NORMAL) : null;
    const sampler = samplers.get(prim.material);
    const texCoordSet = sampler && sampler.texCoord ? sampler.texCoord : 0;
    const uvAttr = prim.attributes[`TEXCOORD_${texCoordSet}`];
    const hasUV = uvAttr !== undefined;
    const uvRaw = hasUV ? readAccessor(uvAttr) : null;
    const constColor = sampler && sampler.constColor ? sampler.constColor : DEFAULT_COLOR;

    const base = gPositions.length / 3;
    for (let v = 0; v < vCount; v++) {
      const p = transformPoint(world, posRaw[v * 3], posRaw[v * 3 + 1], posRaw[v * 3 + 2]);
      gPositions.push(p[0], p[1], p[2]);
      if (hasNormals) {
        const n = transformNormal(nmat, normRaw[v * 3], normRaw[v * 3 + 1], normRaw[v * 3 + 2]);
        gNormals.push(n[0], n[1], n[2]);
      } else {
        gNormals.push(0, 0, 0);
        vertsMissingNormals++;
      }
      let color;
      if (hasUV && sampler && !sampler.constColor) {
        color = samplerColor(sampler, uvRaw[v * 2], uvRaw[v * 2 + 1]);
      } else {
        if (!hasUV) vertsMissingUV++;
        color = constColor;
      }
      gColors.push(color[0], color[1], color[2]);

      // Emit the per-vertex UV in the SAME convention used for baking: the raw
      // TEXCOORD_0 value, post KHR_texture_transform (if any) but WITHOUT any V
      // flip (textureFlipV is carried in meta and applied by the renderer). For
      // vertices lacking UVs, store [0,0].
      if (hasUV) {
        let uu = uvRaw[v * 2], vv = uvRaw[v * 2 + 1];
        if (sampler && sampler.transform) [uu, vv] = applyTextureTransform(uu, vv, sampler.transform);
        gUvs.push(uu, vv);
      } else {
        gUvs.push(0, 0);
      }
    }

    if (prim.indices !== undefined) {
      const idx = readAccessor(prim.indices);
      for (let i = 0; i < idx.length; i++) gIndices.push(idx[i] + base);
    } else {
      for (let i = 0; i < vCount; i++) gIndices.push(i + base);
    }
    primCount++;
  }

  function processMesh(meshIndex, world) {
    const mesh = json.meshes[meshIndex];
    const nmat = normalMatrix(world);
    for (const prim of mesh.primitives) processPrimitive(prim, world, nmat);
  }

  function walkNode(nodeIndex, parentMatrix) {
    const node = json.nodes[nodeIndex];
    const world = mat4Multiply(parentMatrix, nodeLocalMatrix(node));
    if (node.mesh !== undefined) processMesh(node.mesh, world);
    if (node.children) {
      for (const child of node.children) walkNode(child, world);
    }
  }

  let roots = null;
  if (json.scenes && json.scenes.length) {
    const sceneIndex = json.scene !== undefined ? json.scene : 0;
    roots = json.scenes[sceneIndex].nodes || [];
  }
  if (roots && roots.length) {
    for (const r of roots) walkNode(r, mat4Identity());
  } else if (json.nodes && json.nodes.length) {
    for (let i = 0; i < json.nodes.length; i++) walkNode(i, mat4Identity());
  } else if (json.meshes) {
    for (let i = 0; i < json.meshes.length; i++) processMesh(i, mat4Identity());
  }

  return {
    positions: gPositions,
    normals: gNormals,
    colors: gColors,
    uvs: gUvs,
    indices: gIndices,
    vertsMissingNormals,
    vertsMissingUV,
    primCount,
    skippedNonTri,
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function computeBBox(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const val = positions[i + c];
      if (val < min[c]) min[c] = val;
      if (val > max[c]) max[c] = val;
    }
  }
  return { min, max };
}

function recomputeNormals(mesh) {
  const n = mesh.positions.length / 3;
  const normals = new Array(n * 3).fill(0);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t], ib = mesh.indices[t + 1], ic = mesh.indices[t + 2];
    const ax = mesh.positions[ia * 3], ay = mesh.positions[ia * 3 + 1], az = mesh.positions[ia * 3 + 2];
    const bx = mesh.positions[ib * 3], by = mesh.positions[ib * 3 + 1], bz = mesh.positions[ib * 3 + 2];
    const cx = mesh.positions[ic * 3], cy = mesh.positions[ic * 3 + 1], cz = mesh.positions[ic * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const idx of [ia, ib, ic]) {
      normals[idx * 3] += nx;
      normals[idx * 3 + 1] += ny;
      normals[idx * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    let x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2];
    const len = Math.hypot(x, y, z);
    if (len < 1e-8) { normals[i * 3] = 0; normals[i * 3 + 1] = 1; normals[i * 3 + 2] = 0; }
    else { normals[i * 3] = x / len; normals[i * 3 + 1] = y / len; normals[i * 3 + 2] = z / len; }
  }
  mesh.normals = normals;
}

// Grid vertex-clustering decimation for a given cell size. Averages position,
// normal AND baked color within each occupied cell so texture color survives.
function clusterMesh(mesh, bb, cell) {
  const inv = 1 / cell;
  const vCount = mesh.positions.length / 3;
  const map = new Map();
  const cells = [];
  const vertMap = new Int32Array(vCount);
  const P = mesh.positions, Nn = mesh.normals, Cc = mesh.colors, Uv = mesh.uvs;

  const spanY = Math.max(1, Math.ceil((bb.max[1] - bb.min[1]) * inv) + 2);
  const spanZ = Math.max(1, Math.ceil((bb.max[2] - bb.min[2]) * inv) + 2);

  for (let v = 0; v < vCount; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const ix = Math.floor((x - bb.min[0]) * inv);
    const iy = Math.floor((y - bb.min[1]) * inv);
    const iz = Math.floor((z - bb.min[2]) * inv);
    const key = (ix * spanY + iy) * spanZ + iz;
    let ci = map.get(key);
    if (ci === undefined) {
      ci = cells.length;
      map.set(key, ci);
      cells.push({ sx: 0, sy: 0, sz: 0, nx: 0, ny: 0, nz: 0, r: 0, g: 0, b: 0, u: 0, vv: 0, count: 0 });
    }
    const d = cells[ci];
    d.sx += x; d.sy += y; d.sz += z;
    d.nx += Nn[v * 3]; d.ny += Nn[v * 3 + 1]; d.nz += Nn[v * 3 + 2];
    d.r += Cc[v * 3]; d.g += Cc[v * 3 + 1]; d.b += Cc[v * 3 + 2];
    d.u += Uv[v * 2]; d.vv += Uv[v * 2 + 1];
    d.count++;
    vertMap[v] = ci;
  }

  const positions = new Array(cells.length * 3);
  const normals = new Array(cells.length * 3);
  const colors = new Array(cells.length * 3);
  const uvs = new Array(cells.length * 2);
  for (let i = 0; i < cells.length; i++) {
    const d = cells[i];
    positions[i * 3] = d.sx / d.count;
    positions[i * 3 + 1] = d.sy / d.count;
    positions[i * 3 + 2] = d.sz / d.count;
    let nx = d.nx / d.count, ny = d.ny / d.count, nz = d.nz / d.count;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) { nx = 0; ny = 1; nz = 0; } else { nx /= len; ny /= len; nz /= len; }
    normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
    colors[i * 3] = Math.round(d.r / d.count);
    colors[i * 3 + 1] = Math.round(d.g / d.count);
    colors[i * 3 + 2] = Math.round(d.b / d.count);
    uvs[i * 2] = d.u / d.count;
    uvs[i * 2 + 1] = d.vv / d.count;
  }

  const indices = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = vertMap[mesh.indices[t]];
    const b = vertMap[mesh.indices[t + 1]];
    const c = vertMap[mesh.indices[t + 2]];
    if (a === b || b === c || a === c) continue; // degenerate
    indices.push(a, b, c);
  }

  return compactMesh({ positions, normals, colors, uvs, indices });
}

// Remove vertices not referenced by any index; remap indices.
function compactMesh(mesh) {
  const vCount = mesh.positions.length / 3;
  const used = new Int32Array(vCount).fill(-1);
  const positions = [], normals = [], colors = [], uvs = [];
  let next = 0;
  const indices = new Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const old = mesh.indices[i];
    let ni = used[old];
    if (ni === -1) {
      ni = next++;
      used[old] = ni;
      positions.push(mesh.positions[old * 3], mesh.positions[old * 3 + 1], mesh.positions[old * 3 + 2]);
      normals.push(mesh.normals[old * 3], mesh.normals[old * 3 + 1], mesh.normals[old * 3 + 2]);
      colors.push(mesh.colors[old * 3], mesh.colors[old * 3 + 1], mesh.colors[old * 3 + 2]);
      uvs.push(mesh.uvs[old * 2], mesh.uvs[old * 2 + 1]);
    }
    indices[i] = ni;
  }
  return { positions, normals, colors, uvs, indices };
}

// Grid vertex-clustering search: find the grid resolution N (cells along the
// longest bbox axis) whose triangle count lands in [targetMin, targetMax], or
// the closest achievable. Triangle count grows monotonically with N.
function decimateToRange(mesh, bb, targetMin, targetMax) {
  const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
  const maxDim = Math.max(dims[0], dims[1], dims[2]) || 1;
  const target = (targetMin + targetMax) / 2;
  const cache = new Map();
  const evalN = (N) => {
    if (cache.has(N)) return cache.get(N);
    const m = clusterMesh(mesh, bb, maxDim / N);
    const rec = { N, mesh: m, tris: m.indices.length / 3 };
    cache.set(N, rec);
    return rec;
  };

  let lo = 4, hi = 16;
  // grow hi until we exceed the target (or hit a sane cap)
  while (evalN(hi).tris < target && hi < 8192) hi *= 2;
  // binary search on N for tris ~ target
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (evalN(mid).tris < target) lo = mid + 1;
    else hi = mid;
  }

  // Consider a small neighborhood; prefer the closest-to-target that is in range.
  let best = null;
  const consider = (rec) => {
    const inRange = rec.tris >= targetMin && rec.tris <= targetMax;
    const dist = Math.abs(rec.tris - target);
    const score = { inRange, dist, rec };
    if (best === null) { best = score; return; }
    if (score.inRange && !best.inRange) { best = score; return; }
    if (score.inRange === best.inRange && score.dist < best.dist) { best = score; return; }
  };
  for (let N = Math.max(4, lo - 3); N <= lo + 3; N++) consider(evalN(N));

  return { mesh: best.rec.mesh, tris: best.rec.tris, grid: best.rec.N, cell: maxDim / best.rec.N };
}

// ---------------------------------------------------------------------------
// Horizontal (XZ) alignment (unchanged from the original compiler)
// ---------------------------------------------------------------------------
function hullPCAAxis(mesh) {
  const bb = computeBBox(mesh.positions);
  const H = bb.max[1] - bb.min[1];
  const yMax = bb.min[1] + 0.5 * H;
  const P = mesh.positions;
  let sx = 0, sz = 0, c = 0;
  for (let i = 0; i < P.length; i += 3) { if (P[i + 1] <= yMax) { sx += P[i]; sz += P[i + 2]; c++; } }
  if (c < 3) return null;
  const mx = sx / c, mz = sz / c;
  let cxx = 0, czz = 0, cxz = 0;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i + 1] <= yMax) { const dx = P[i] - mx, dz = P[i + 2] - mz; cxx += dx * dx; czz += dz * dz; cxz += dx * dz; }
  }
  cxx /= c; czz /= c; cxz /= c;
  const tr = cxx + czz;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (cxx * czz - cxz * cxz)));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  let ex, ez;
  if (Math.abs(cxz) > 1e-12) { ex = l1 - czz; ez = cxz; }
  else { ex = cxx >= czz ? 1 : 0; ez = cxx >= czz ? 0 : 1; }
  const len = Math.hypot(ex, ez) || 1; ex /= len; ez /= len;
  return {
    ex, ez,
    ratio: l2 > 1e-12 ? Math.sqrt(l1 / l2) : Infinity,
    angleDeg: Math.atan2(ez, ex) * 180 / Math.PI,
  };
}

function rotateYToZ(mesh, ex, ez) {
  const P = mesh.positions, Nn = mesh.normals;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], z = P[i + 2];
    P[i] = ez * x - ex * z;
    P[i + 2] = ex * x + ez * z;
    const nx = Nn[i], nz = Nn[i + 2];
    Nn[i] = ez * nx - ex * nz;
    Nn[i + 2] = ex * nx + ez * nz;
  }
}

function flip180Y(mesh) {
  const P = mesh.positions, Nn = mesh.normals;
  for (let i = 0; i < P.length; i += 3) {
    P[i] = -P[i]; P[i + 2] = -P[i + 2];
    Nn[i] = -Nn[i]; Nn[i + 2] = -Nn[i + 2];
  }
}

function bowEndWidths(mesh) {
  const bb = computeBBox(mesh.positions);
  const H = bb.max[1] - bb.min[1];
  const yMax = bb.min[1] + 0.45 * H;
  const zMin = bb.min[2], zR = (bb.max[2] - bb.min[2]) || 1;
  const P = mesh.positions;
  let pMn = Infinity, pMx = -Infinity, nMn = Infinity, nMx = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i + 1] > yMax) continue;
    const f = (P[i + 2] - zMin) / zR, x = P[i];
    if (f >= 0.85) { if (x < pMn) pMn = x; if (x > pMx) pMx = x; }
    else if (f <= 0.15) { if (x < nMn) nMn = x; if (x > nMx) nMx = x; }
  }
  const wPlus = (pMx - pMn) || 0, wMinus = (nMx - nMn) || 0;
  return { wPlus, wMinus, bowPlusZ: wPlus <= wMinus };
}

// ---------------------------------------------------------------------------
// Color diagnostics
// ---------------------------------------------------------------------------
function colorStats(colors) {
  const n = colors.length / 3;
  const mean = [0, 0, 0];
  for (let i = 0; i < colors.length; i += 3) { mean[0] += colors[i]; mean[1] += colors[i + 1]; mean[2] += colors[i + 2]; }
  mean[0] /= n; mean[1] /= n; mean[2] /= n;
  const varc = [0, 0, 0];
  for (let i = 0; i < colors.length; i += 3) {
    varc[0] += (colors[i] - mean[0]) ** 2;
    varc[1] += (colors[i + 1] - mean[1]) ** 2;
    varc[2] += (colors[i + 2] - mean[2]) ** 2;
  }
  varc[0] /= n; varc[1] /= n; varc[2] /= n;
  return { mean, varc, varAvg: (varc[0] + varc[1] + varc[2]) / 3 };
}

// Average color of the lower third vs upper third by Y (hull vs sails/rigging).
function verticalColorSplit(mesh) {
  const P = mesh.positions, C = mesh.colors;
  const bb = computeBBox(P);
  const H = (bb.max[1] - bb.min[1]) || 1;
  const loCut = bb.min[1] + H / 3;
  const hiCut = bb.max[1] - H / 3;
  const lo = [0, 0, 0], hi = [0, 0, 0];
  let ln = 0, hn = 0;
  for (let i = 0; i < P.length; i += 3) {
    const y = P[i + 1], vi = i;
    if (y <= loCut) { lo[0] += C[vi]; lo[1] += C[vi + 1]; lo[2] += C[vi + 2]; ln++; }
    else if (y >= hiCut) { hi[0] += C[vi]; hi[1] += C[vi + 1]; hi[2] += C[vi + 2]; hn++; }
  }
  const norm = (a, n) => n ? [a[0] / n, a[1] / n, a[2] / n].map(v => Math.round(v)) : [0, 0, 0];
  const lc = norm(lo, ln), hc = norm(hi, hn);
  return {
    lower: lc, lowerCount: ln, lowerLuma: 0.299 * lc[0] + 0.587 * lc[1] + 0.114 * lc[2],
    upper: hc, upperCount: hn, upperLuma: 0.299 * hc[0] + 0.587 * hc[1] + 0.114 * hc[2],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function fmt(n, d = 4) { return Number(n.toFixed(d)); }

async function main() {
  if (!fs.existsSync(INPUT_PATH)) throw new Error(`input GLB not found: ${INPUT_PATH}`);
  console.log(`\n=== compile-glb (textured, multi-LOD) ===`);
  console.log(`Source GLB: ${INPUT_PATH}`);
  const buf = fs.readFileSync(INPUT_PATH);
  const { json, bin } = parseGLB(buf);
  if (!bin) throw new Error('no BIN chunk found');
  const req = json.extensionsRequired || [];
  const unsupported = req.filter(e => e === 'EXT_meshopt_compression' || e === 'KHR_draco_mesh_compression');
  if (unsupported.length) throw new Error(`requires compressed-geometry extension(s): ${unsupported.join(', ')}`);

  console.log(`glTF: ${json.meshes?.length || 0} meshes, ${json.nodes?.length || 0} nodes, ${json.materials?.length || 0} materials, ${json.accessors?.length || 0} accessors`);
  console.log(`extensionsUsed: ${(json.extensionsUsed || []).join(', ') || '(none)'}`);

  // --- Decode textures + build per-material samplers (try flipV=false first) ---
  let flipV = false;
  let samplers = await buildMaterialSamplers(json, bin, { flipV });
  // Report decoded texture info (first textured material).
  let texInfo = null;
  for (const s of samplers.values()) { if (s.tex) { texInfo = s; break; } }
  if (texInfo) {
    console.log(`Decoded baseColor texture: ${texInfo.tex.width}x${texInfo.tex.height}, ${texInfo.tex.channels} channels`);
  } else {
    console.log(`No baseColor texture found; using material/base colors.`);
  }

  // --- Merge whole model, baking texture colors per vertex ---
  let mesh = compileMerged(json, bin, samplers);
  const mergedVerts = mesh.positions.length / 3;
  const mergedTris = mesh.indices.length / 3;
  console.log(`Merged: ${mergedVerts} verts, ${mergedTris} tris, ${mesh.primCount} primitives (skipped ${mesh.skippedNonTri} non-tri)`);
  console.log(`Missing normals: ${mesh.vertsMissingNormals}, missing UVs: ${mesh.vertsMissingUV}`);

  // If a texture exists, verify V orientation: hull (lower Y) should read darker
  // (wood) than sails/rigging (upper Y). If inverted, re-bake with flipV.
  if (ALIGN && texInfo) {
    const split = verticalColorSplit(mesh);
    console.log(`V-orientation check (flipV=${flipV}): lower Y luma=${fmt(split.lowerLuma, 1)} vs upper Y luma=${fmt(split.upperLuma, 1)}`);
    // Heuristic: a painted galleon's hull (lower) should not be brighter than the
    // sails (upper). If lower is clearly brighter, the texture is likely V-flipped.
    if (split.lowerLuma > split.upperLuma + 25) {
      console.log(`Lower third notably brighter than upper -> re-baking with flipV=true`);
      flipV = true;
      samplers = await buildMaterialSamplers(json, bin, { flipV });
      mesh = compileMerged(json, bin, samplers);
      const split2 = verticalColorSplit(mesh);
      console.log(`After flipV=true: lower Y luma=${fmt(split2.lowerLuma, 1)} vs upper Y luma=${fmt(split2.upperLuma, 1)}`);
    }
  }

  // Full-mesh baked-color stats (before decimation) to confirm real texture data.
  const fullStats = colorStats(mesh.colors);
  console.log(`Baked color (full mesh): mean=[${fullStats.mean.map(v => fmt(v, 1))}], varAvg=${fmt(fullStats.varAvg, 1)}`);

  const bbOrig = computeBBox(mesh.positions);
  const origDims = [bbOrig.max[0] - bbOrig.min[0], bbOrig.max[1] - bbOrig.min[1], bbOrig.max[2] - bbOrig.min[2]];
  console.log(`Original bbox min=[${bbOrig.min.map(v => fmt(v, 3))}] max=[${bbOrig.max.map(v => fmt(v, 3))}] dims=[${origDims.map(v => fmt(v, 3))}]`);

  // Recompute normals only if a large fraction lacked them.
  const missingFrac = mesh.vertsMissingNormals / mergedVerts;
  if (missingFrac > 0.3) {
    console.log(`Recomputing normals (missing ${fmt(missingFrac * 100, 1)}% > 30%)`);
    recomputeNormals(mesh);
  }

  // Align hull long axis -> +Z, bow -> +Z (rotation about Y keeps Y-up).
  let lengthAxis = 'Z', bowDir = '+Z';
  const pca = hullPCAAxis(mesh);
  if (ALIGN && pca && pca.ratio > 1.15) {
    rotateYToZ(mesh, pca.ex, pca.ez);
    const bow = bowEndWidths(mesh);
    if (!bow.bowPlusZ) flip180Y(mesh);
    console.log(`Aligned: rotated ${fmt(-pca.angleDeg, 1)}deg about Y so hull length -> Z (PCA L/W=${fmt(pca.ratio, 2)}); bow -> +Z (beam +Z=${fmt(bow.wPlus, 3)} vs -Z=${fmt(bow.wMinus, 3)})`);
  } else {
    console.log(`No horizontal alignment (footprint not clearly elongated${pca ? `, L/W=${fmt(pca.ratio, 2)}` : ''})`);
    lengthAxis = '(ambiguous)'; bowDir = '(ambiguous)';
  }

  // Oriented-mesh bbox (source units) drives the LOD clustering grid.
  const bbOriented = computeBBox(mesh.positions);

  // --- Build the three LODs (cluster the SAME oriented source mesh) ---
  console.log(`\nBuilding LODs...`);
  const lodRaw = [];
  for (const tgt of LOD_TARGETS) {
    const res = decimateToRange(mesh, bbOriented, tgt.min, tgt.max);
    console.log(`  ${tgt.name}: grid N=${res.grid}, ${res.tris} tris (target ${tgt.min}-${tgt.max})`);
    lodRaw.push(res.mesh);
  }

  // --- One shared recenter+scale transform, derived from LOD0 ---
  const bbL0 = computeBBox(lodRaw[0].positions);
  const cx = (bbL0.min[0] + bbL0.max[0]) / 2;
  const cz = (bbL0.min[2] + bbL0.max[2]) / 2;
  const minY = bbL0.min[1];
  const xExt = bbL0.max[0] - bbL0.min[0];
  const zExt = bbL0.max[2] - bbL0.min[2];
  const horiz = Math.max(xExt, zExt) || 1;
  const scale = TARGET_HORIZONTAL_SIZE / horiz;
  console.log(`Shared transform (from LOD0): recenter x=${fmt(cx, 4)} z=${fmt(cz, 4)} minY=${fmt(minY, 4)}, scale=${fmt(scale, 6)}`);

  function applyShared(m) {
    const P = m.positions;
    for (let i = 0; i < P.length; i += 3) {
      P[i] = (P[i] - cx) * scale;
      P[i + 1] = (P[i + 1] - minY) * scale;
      P[i + 2] = (P[i + 2] - cz) * scale;
    }
  }
  for (const m of lodRaw) applyShared(m);

  // Snap each LOD's own min-Y to exactly 0 (cluster centroids of coarse LODs sit
  // slightly above the true hull bottom). Keeps the shared scale + X/Z center so
  // LODs stay aligned, while every LOD rests on the waterline (min-Y ~= 0).
  for (const m of lodRaw) {
    const bb = computeBBox(m.positions);
    const dy = bb.min[1];
    if (Math.abs(dy) > 1e-9) {
      for (let i = 1; i < m.positions.length; i += 3) m.positions[i] -= dy;
    }
  }

  // --- Per-LOD normal fix-up + validation ---
  const lodsOut = [];
  const lodTriangles = [];
  const errorsAll = [];
  for (let li = 0; li < lodRaw.length; li++) {
    const m = lodRaw[li];
    const vCount = m.positions.length / 3;
    // fix any degenerate normals produced by clustering
    let bad = 0;
    for (let i = 0; i < vCount; i++) {
      const len = Math.hypot(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]);
      if (!isFinite(len) || len < 0.5 || len > 1.5) bad++;
    }
    if (bad / vCount > 0.1) {
      console.log(`  ${LOD_TARGETS[li].name}: recomputing normals (${bad}/${vCount} degenerate)`);
      recomputeNormals(m);
    } else {
      // renormalize the handful that drifted
      for (let i = 0; i < vCount; i++) {
        const x = m.normals[i * 3], y = m.normals[i * 3 + 1], z = m.normals[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        m.normals[i * 3] = x / len; m.normals[i * 3 + 1] = y / len; m.normals[i * 3 + 2] = z / len;
      }
    }

    // validation
    const errs = [];
    for (let i = 0; i < m.indices.length; i++) {
      const v = m.indices[i];
      if (!Number.isInteger(v) || v < 0 || v >= vCount) { errs.push(`index out of range at ${i}: ${v}`); break; }
    }
    for (let i = 0; i < m.positions.length; i++) if (!isFinite(m.positions[i])) { errs.push(`non-finite position at ${i}`); break; }
    for (let i = 0; i < m.normals.length; i++) if (!isFinite(m.normals[i])) { errs.push(`non-finite normal at ${i}`); break; }
    if (m.colors.length !== m.positions.length) errs.push(`colors length mismatch (${m.colors.length} vs ${m.positions.length})`);
    if (m.normals.length !== m.positions.length) errs.push(`normals length mismatch (${m.normals.length} vs ${m.positions.length})`);
    if (m.uvs.length !== (m.positions.length / 3) * 2) errs.push(`uvs length mismatch (${m.uvs.length} vs ${(m.positions.length / 3) * 2})`);
    for (let i = 0; i < m.uvs.length; i++) if (!isFinite(m.uvs[i])) { errs.push(`non-finite uv at ${i}`); break; }
    if (m.indices.length % 3 !== 0) errs.push(`indices not a multiple of 3`);
    if (errs.length) errorsAll.push(`${LOD_TARGETS[li].name}: ${errs.join('; ')}`);

    lodTriangles.push(m.indices.length / 3);
    lodsOut.push({
      positions: m.positions.map(v => fmt(v, 5)),
      normals: m.normals.map(v => fmt(v, 5)),
      colors: m.colors.map(v => Math.max(0, Math.min(255, Math.round(v)))),
      uvs: m.uvs.map(v => fmt(v, 6)),
      indices: m.indices,
    });
  }

  if (errorsAll.length) {
    console.error(`\nVALIDATION FAILED:`);
    for (const e of errorsAll) console.error(`  - ${e}`);
    process.exit(1);
  }

  // --- Bounds from LOD0 ---
  const bbFinal = computeBBox(lodRaw[0].positions);
  const center = [
    (bbFinal.min[0] + bbFinal.max[0]) / 2,
    (bbFinal.min[1] + bbFinal.max[1]) / 2,
    (bbFinal.min[2] + bbFinal.max[2]) / 2,
  ];
  let radius = 0;
  for (let i = 0; i < lodRaw[0].positions.length; i += 3) {
    const dx = lodRaw[0].positions[i] - center[0];
    const dy = lodRaw[0].positions[i + 1] - center[1];
    const dz = lodRaw[0].positions[i + 2] - center[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > radius) radius = d;
  }

  // --- Write the decoded baseColor texture to a raw RGB binary ---
  // Layout: uint32 LE width, uint32 LE height, then width*height*3 bytes of RGB
  // (row-major, row 0 = top of image, no alpha) -- the SAME decoded buffer used
  // for per-vertex color baking (sharp .removeAlpha().raw()).
  let texFileMeta = null;
  if (texInfo) {
    const tw = texInfo.tex.width, th = texInfo.tex.height, tch = texInfo.tex.channels;
    let rgb = texInfo.tex.data;
    if (tch !== 3) {
      // Defensive: repack to exactly 3 channels if the decode kept an alpha lane.
      const packed = Buffer.alloc(tw * th * 3);
      for (let p = 0; p < tw * th; p++) {
        packed[p * 3] = rgb[p * tch];
        packed[p * 3 + 1] = rgb[p * tch + 1];
        packed[p * 3 + 2] = rgb[p * tch + 2];
      }
      rgb = packed;
    }
    let outW = tw, outH = th, outRgb = rgb;
    const MAXT = 320;
    if (Math.max(tw, th) > MAXT) {
      const sc = MAXT / Math.max(tw, th);
      outW = Math.max(1, Math.round(tw * sc));
      outH = Math.max(1, Math.round(th * sc));
      outRgb = await sharp(Buffer.from(rgb), { raw: { width: tw, height: th, channels: 3 } }).resize(outW, outH).raw().toBuffer();
    }
    const header = Buffer.alloc(8);
    header.writeUInt32LE(outW, 0);
    header.writeUInt32LE(outH, 4);
    fs.mkdirSync(path.dirname(TEX_OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(TEX_OUTPUT_PATH, Buffer.concat([header, Buffer.from(outRgb)]));
    const texStat = fs.statSync(TEX_OUTPUT_PATH);
    texFileMeta = { file: path.basename(TEX_OUTPUT_PATH), width: outW, height: outH };
    console.log(`\nWrote texture: ${TEX_OUTPUT_PATH} (${texStat.size} bytes; header ${tw}x${th})`);
  }

  // --- Emit ---
  const out = {
    id: ID,
    texture: texFileMeta,
    lods: lodsOut,
    bounds: {
      min: bbFinal.min.map(v => fmt(v, 5)),
      max: bbFinal.max.map(v => fmt(v, 5)),
      radius: fmt(radius, 5),
    },
    meta: {
      sourceFile: INPUT_PATH,
      lodTriangles,
      textureBaked: !!texInfo,
      textureSize: texInfo ? [texInfo.tex.width, texInfo.tex.height] : null,
      textureFlipV: flipV,
      appliedScale: fmt(scale, 8),
    },
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out));
  const stat = fs.statSync(OUTPUT_PATH);

  // --- Summary / diagnostics ---
  console.log(`\n--- SUMMARY ---`);
  const finalDims = [
    bbFinal.max[0] - bbFinal.min[0],
    bbFinal.max[1] - bbFinal.min[1],
    bbFinal.max[2] - bbFinal.min[2],
  ];
  console.log(`LOD triangle counts: ${lodTriangles.join(', ')}`);
  for (let li = 0; li < lodRaw.length; li++) {
    const m = lodRaw[li];
    const st = colorStats(m.colors);
    const split = verticalColorSplit(m);
    const bb = computeBBox(m.positions);
    const dims = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
    // UV range diagnostics
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < m.uvs.length; i += 2) {
      const u = m.uvs[i], vv = m.uvs[i + 1];
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv;
    }
    console.log(`  ${LOD_TARGETS[li].name}: verts=${m.positions.length / 3}, tris=${m.indices.length / 3}, uvs=${m.uvs.length} (=2/3 pos? ${m.uvs.length === (m.positions.length / 3) * 2})`);
    console.log(`      color mean=[${st.mean.map(v => fmt(v, 1))}] varAvg=${fmt(st.varAvg, 1)} (per-ch var=[${st.varc.map(v => fmt(v, 0))}])`);
    console.log(`      uv range: u=[${fmt(uMin, 4)}, ${fmt(uMax, 4)}] v=[${fmt(vMin, 4)}, ${fmt(vMax, 4)}]`);
    console.log(`      lower-third(hull) color=[${split.lower}] luma=${fmt(split.lowerLuma, 1)} | upper-third(sails) color=[${split.upper}] luma=${fmt(split.upperLuma, 1)}`);
    console.log(`      bbox min=[${bb.min.map(v => fmt(v, 4))}] dims=[${dims.map(v => fmt(v, 4))}] minY=${fmt(bb.min[1], 5)} horizExt=${fmt(Math.max(dims[0], dims[2]), 4)}`);
  }

  // --- Texture spot-check: sample boat.tex.bin at a few LOD0 vertex UVs and
  //     confirm low-Y (hull) reads darker than high-Y (sail/rigging). ---
  if (texInfo) {
    const m0 = lodRaw[0];
    const bb0 = computeBBox(m0.positions);
    const H0 = (bb0.max[1] - bb0.min[1]) || 1;
    const tw = texInfo.tex.width, th = texInfo.tex.height, td = texInfo.tex.data, tch = texInfo.tex.channels;
    // sample = floor(v*(h-1)) row, floor(u*(w-1)) col; flipV=false (confirmed).
    const sampleUV = (u, vv) => {
      const uu = Math.min(1, Math.max(0, u)), v2 = Math.min(1, Math.max(0, vv));
      const px = Math.floor(uu * (tw - 1));
      const py = Math.floor((flipV ? 1 - v2 : v2) * (th - 1));
      const o = (py * tw + px) * tch;
      return [td[o], td[o + 1], td[o + 2]];
    };
    const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    const vCount0 = m0.positions.length / 3;
    // gather a few low-Y and a few high-Y vertices
    const idxs = [];
    for (let i = 0; i < vCount0; i++) idxs.push(i);
    idxs.sort((a, b) => m0.positions[a * 3 + 1] - m0.positions[b * 3 + 1]);
    const pick = (arr) => arr.map(i => {
      const u = m0.uvs[i * 2], vv = m0.uvs[i * 2 + 1];
      const c = sampleUV(u, vv);
      return { y: fmt(m0.positions[i * 3 + 1], 3), uv: [fmt(u, 3), fmt(vv, 3)], rgb: c, luma: fmt(luma(c), 1) };
    });
    const lowSamples = pick([idxs[0], idxs[1], idxs[2], idxs[3], idxs[4]]);
    const hiSamples = pick([idxs[vCount0 - 1], idxs[vCount0 - 2], idxs[vCount0 - 3], idxs[vCount0 - 4], idxs[vCount0 - 5]]);
    console.log(`\nTexture spot-check (sampling boat.tex.bin at LOD0 vertex UVs, flipV=${flipV}):`);
    for (const s of lowSamples) console.log(`   HULL  y=${s.y} uv=[${s.uv}] -> rgb=[${s.rgb}] luma=${s.luma}`);
    for (const s of hiSamples) console.log(`   SAIL  y=${s.y} uv=[${s.uv}] -> rgb=[${s.rgb}] luma=${s.luma}`);
    const avgLuma = (a) => a.reduce((s, x) => s + Number(x.luma), 0) / a.length;
    console.log(`   avg hull luma=${fmt(avgLuma(lowSamples), 1)} vs avg sail luma=${fmt(avgLuma(hiSamples), 1)} (hull should be darker)`);
  }
  console.log(`\nLOD0 checks: minY=${fmt(bbFinal.min[1], 6)} (target ~0), horizExt=${fmt(Math.max(finalDims[0], finalDims[2]), 4)} m (target ${TARGET_HORIZONTAL_SIZE}), bow=${bowDir} along +Z`);
  console.log(`LOD0 dims: beam(X)=${fmt(finalDims[0], 3)} height(Y)=${fmt(finalDims[1], 3)} length(Z)=${fmt(finalDims[2], 3)}`);
  console.log(`bounds.radius=${fmt(radius, 4)}, appliedScale=${fmt(scale, 6)}`);
  console.log(`Output: ${OUTPUT_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
