import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Texture } from '@tellus/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const MESH_DIR = join(HERE, '../../assets/meshes');

export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  uvs?: Float32Array;
}

export interface Model {
  lods: Mesh[];
  texture?: Texture;
}

/** Load a compiled model (id.mesh.json [+ id.tex.bin]) into typed-array LODs. */
export function loadModel(id: string): Model {
  const j = JSON.parse(readFileSync(join(MESH_DIR, `${id}.mesh.json`), 'utf8')) as {
    lods: Array<{ positions: number[]; normals: number[]; colors: number[]; indices: number[]; uvs?: number[] }>;
  };
  const lods: Mesh[] = (j.lods ?? []).map((l) => ({
    positions: Float32Array.from(l.positions),
    normals: Float32Array.from(l.normals),
    colors: Uint8Array.from(l.colors),
    indices: Uint32Array.from(l.indices),
    uvs: l.uvs ? Float32Array.from(l.uvs) : undefined,
  }));
  let texture: Texture | undefined;
  try {
    const buf = readFileSync(join(MESH_DIR, `${id}.tex.bin`));
    const width = buf.readUInt32LE(0);
    const height = buf.readUInt32LE(4);
    if (width > 0 && height > 0 && buf.length >= 8 + width * height * 3) {
      texture = { width, height, data: new Uint8Array(buf.buffer, buf.byteOffset + 8, width * height * 3) };
    }
  } catch {
    /* vertex colours only */
  }
  return { lods, texture };
}
