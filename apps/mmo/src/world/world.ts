import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTerrainChunks, scatterPoints, heightAt, WORLD_HALF, type TerrainChunk } from './terrain.js';
import type { Mesh } from './mesh.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG = join(HERE, '../../assets/meshes/catalog.json');
const TAU = Math.PI * 2;

export interface CatalogEntry {
  id: string;
  title: string;
  kind: string;
  size: number;
}

export interface PropInstance {
  id: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  y?: number; // absolute Y (for things that float, like balloons); else ground
}

export interface Agent {
  id: number;
  name: string;
  mesh: string;
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
  isPlayer: boolean;
}

export interface Player extends Agent {
  isPlayer: true;
}

/** Minimal per-frame agent state shipped to render workers (positions only). */
export interface AgentSnapshot {
  id: number;
  name: string;
  mesh: string;
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
  isPlayer: boolean;
}

interface Creature extends Agent {
  isPlayer: false;
  tx: number;
  tz: number;
  speed: number;
}

function loadCatalog(): CatalogEntry[] {
  try {
    return JSON.parse(readFileSync(CATALOG, 'utf8')) as CatalogEntry[];
  } catch {
    return [];
  }
}

export class World {
  readonly terrain: TerrainChunk[] = buildTerrainChunks(60, 4);
  readonly catalog = loadCatalog();
  readonly props: PropInstance[] = [];
  readonly buildings: Array<{ x: number; z: number; r: number }> = [];
  readonly players = new Map<number, Player>();
  private readonly creatures: Creature[] = [];
  private nextId = 1;

  readonly heroMesh: string;
  private readonly creatureMeshes: string[];

  constructor() {
    const cat = this.catalog;
    const byTitle = (re: RegExp): CatalogEntry[] => cat.filter((c) => re.test(c.title || ''));
    const of = (k: string): CatalogEntry[] => cat.filter((c) => c.kind === k);

    const trees = of('tree');
    const knight = byTitle(/knight/i)[0] ?? byTitle(/wolf warrior/i)[0] ?? of('hero')[0];
    const horses = of('horse');
    const dogs = byTitle(/retriever|spaniel|highland|westie|puppy|shepherd|cocker|bloodhound|bulldog|terrier/i);
    const balloons = byTitle(/balloon/i);
    const lanterns = byTitle(/lantern/i);
    const wells = byTitle(/well/i);
    const heads = byTitle(/olmec|mesoamerican|stone head/i);
    const vases = byTitle(/vase/i);
    const carousel = byTitle(/carousel/i);
    const houses = byTitle(/shrine|gatehouse|thatched|storybook|fairy tale|inn|shop house|log cabin|cottage/i);

    this.heroMesh = (knight ?? dogs[0] ?? cat[0]!).id;
    this.creatureMeshes = [...dogs, ...horses].map((c) => c.id);

    let seed = 424242;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    const place = (id: string, x: number, z: number, yaw: number, scale: number, y?: number): void => {
      this.props.push({ id, x, z, yaw, scale, y });
    };

    // --- a small hamlet: a handful of good buildings around a green, off-centre ---
    const gx = 26;
    const gz = -4; // village green centre (spawn is at origin, in the meadow beside it)
    const useHouses = houses.slice(0, 6);
    useHouses.forEach((b, i) => {
      const a = (i / useHouses.length) * TAU + 0.4;
      const r = 15 + (i % 2) * 4;
      const x = gx + Math.cos(a) * r;
      const z = gz + Math.sin(a) * r;
      place(b.id, x, z, Math.atan2(gx - x, gz - z), 1.15);
      this.buildings.push({ x, z, r: b.size * 0.65 });
    });
    if (wells[0]) place(wells[0]!.id, gx, gz, 0, 1.1);
    lanterns.slice(0, 4).forEach((l, i) => place(l.id, gx + (i - 1.5) * 4, gz + 12, 0, 1));

    const blocked = (x: number, z: number, pad = 3): boolean =>
      this.buildings.some((b) => Math.hypot(x - b.x, z - b.z) < b.r + pad);

    // --- woodland: the good pine, scattered dense but leaving the green + spawn open ---
    if (trees.length) {
      for (const t of scatterPoints(65, 10, 77, (x, z) => blocked(x, z, 2) || Math.hypot(x - gx, z - gz) < 14)) {
        const tree = trees[Math.abs(Math.round(t.x + t.z)) % trees.length]!;
        place(tree.id, t.x, t.z, t.rot, 0.9 + t.scale * 0.7);
      }
    }

    // --- scattered curiosities: stone heads, a vase, a carousel horse ---
    const curios = [...heads, ...vases, ...carousel];
    curios.forEach((c, i) => {
      const a = i * 2.4 + 1.3;
      const r = 30 + (i % 3) * 12;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!blocked(x, z)) place(c.id, x, z, a, c.kind === 'landmark' ? 1.2 : 1);
    });

    // --- hot-air balloons drifting high in the sky (pure atmosphere) ---
    balloons.slice(0, 3).forEach((b, i) => {
      const a = i * 2.1 + 0.5;
      const r = 30 + i * 14;
      place(b.id, Math.cos(a) * r, Math.sin(a) * r, rnd() * TAU, 2.6, 22 + i * 8);
    });

    // --- animals roaming: recognisable horses (stately) and dogs (quick) ---
    const herd = [...horses.slice(0, 7), ...dogs.slice(0, 7)];
    for (const h of herd) {
      const id = this.nextId++;
      const isHorse = horses.includes(h);
      const x = (rnd() * 2 - 1) * 60;
      const z = (rnd() * 2 - 1) * 60;
      this.creatures.push({
        id,
        name: '',
        mesh: h.id,
        x,
        z,
        yaw: rnd() * TAU,
        moving: false,
        isPlayer: false,
        tx: x,
        tz: z,
        speed: isHorse ? 1.5 + rnd() : 2 + rnd() * 1.4,
      });
    }
  }

  join(name: string): Player {
    const id = this.nextId++;
    const a = Math.random() * TAU;
    const rad = 2 + Math.random() * 5;
    const p: Player = {
      id,
      name,
      mesh: this.heroMesh,
      x: Math.cos(a) * rad,
      z: Math.sin(a) * rad,
      yaw: a,
      moving: false,
      isPlayer: true,
    };
    this.players.set(id, p);
    return p;
  }

  leave(id: number): void {
    this.players.delete(id);
  }

  /** Overwrite all dynamic agents from a snapshot (used by render workers, which don't
   *  run the simulation — the main thread owns it and ships positions each frame). */
  applySnapshot(agents: AgentSnapshot[]): void {
    this.players.clear();
    this.creatures.length = 0;
    for (const a of agents) {
      if (a.isPlayer) {
        this.players.set(a.id, { ...a, isPlayer: true });
      } else {
        this.creatures.push({ ...a, isPlayer: false, tx: a.x, tz: a.z, speed: 0 });
      }
    }
  }

  step(a: Agent, dx: number, dz: number): void {
    const b = WORLD_HALF - 2;
    const nx = Math.min(b, Math.max(-b, a.x + dx));
    const nz = Math.min(b, Math.max(-b, a.z + dz));
    for (const bld of this.buildings) {
      if (Math.hypot(nx - bld.x, nz - bld.z) < bld.r) return;
    }
    a.x = nx;
    a.z = nz;
  }

  groundAt(x: number, z: number): number {
    return heightAt(x, z);
  }

  tick(dt: number): void {
    for (const c of this.creatures) {
      const dx = c.tx - c.x;
      const dz = c.tz - c.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.3) {
        for (let t = 0; t < 6; t++) {
          const nx = c.x + (Math.random() * 2 - 1) * 26;
          const nz = c.z + (Math.random() * 2 - 1) * 26;
          if (Math.abs(nx) < WORLD_HALF - 5 && Math.abs(nz) < WORLD_HALF - 5) {
            c.tx = nx;
            c.tz = nz;
            break;
          }
        }
        c.moving = false;
      } else {
        const s = (c.speed * dt) / d;
        c.x += dx * s;
        c.z += dz * s;
        let da = (Math.atan2(dx, dz) - c.yaw) % TAU;
        if (da > Math.PI) da -= TAU;
        if (da < -Math.PI) da += TAU;
        c.yaw += da * Math.min(1, dt * 6);
        c.moving = true;
      }
    }
  }

  agents(): Agent[] {
    return [...this.players.values(), ...this.creatures];
  }

  /** Compact snapshot of every agent for shipping to render workers. */
  snapshot(): AgentSnapshot[] {
    const out: AgentSnapshot[] = [];
    for (const a of this.players.values()) out.push({ id: a.id, name: a.name, mesh: a.mesh, x: a.x, z: a.z, yaw: a.yaw, moving: a.moving, isPlayer: true });
    for (const c of this.creatures) out.push({ id: c.id, name: c.name, mesh: c.mesh, x: c.x, z: c.z, yaw: c.yaw, moving: c.moving, isPlayer: false });
    return out;
  }

  get population(): number {
    return this.players.size;
  }
}
