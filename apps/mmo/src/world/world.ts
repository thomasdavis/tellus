// The shared world: one deterministic city, built identically everywhere from the
// asset catalog + seeds (that's what lets stateless render workers reconstruct it).
//
// Layout: a paved plaza at the origin, four avenues out to a ring road, and a
// district at each compass point — Old Town (N), the Shrine Quarter (E), Market
// Street (S), the Garden District (W) — with forested countryside beyond the ring.
// Streets carry walking NPCs, cart traffic, and lantern posts that glow at night.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTerrainChunks, scatterPoints, heightAt, roadDist, roadPoint, WORLD_HALF, PLAZA_R, type TerrainChunk } from './terrain.js';

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
  onRoads: boolean; // pedestrians/carts pick targets on the street network
}

function loadCatalog(): CatalogEntry[] {
  try {
    return JSON.parse(readFileSync(CATALOG, 'utf8')) as CatalogEntry[];
  } catch {
    return [];
  }
}

export class World {
  readonly terrain: TerrainChunk[] = buildTerrainChunks(112, 7);
  readonly catalog = loadCatalog();
  readonly props: PropInstance[] = [];
  readonly buildings: Array<{ x: number; z: number; r: number }> = [];
  /** Lantern positions — the renderer makes these glow after dusk. */
  readonly lampPosts: Array<{ x: number; z: number }> = [];
  readonly players = new Map<number, Player>();
  private readonly creatures: Creature[] = [];
  private nextId = 1;

  readonly heroPool: string[];

  constructor() {
    const cat = this.catalog;
    const byTitle = (re: RegExp): CatalogEntry[] => cat.filter((c) => re.test(c.title || ''));
    const of = (k: string): CatalogEntry[] => cat.filter((c) => c.kind === k);

    let seed = 424242;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    const place = (e: CatalogEntry, x: number, z: number, yaw: number, scale = 1, y?: number): void => {
      this.props.push({ id: e.id, x, z, yaw, scale, y });
    };
    const solid = (e: CatalogEntry, x: number, z: number, yaw: number, scale = 1, rFactor = 0.62): void => {
      place(e, x, z, yaw, scale);
      this.buildings.push({ x, z, r: e.size * scale * rFactor });
    };
    const blocked = (x: number, z: number, pad = 3): boolean =>
      this.buildings.some((b) => Math.hypot(x - b.x, z - b.z) < b.r + pad);

    // --- the cast, drawn from the harvested catalog by kind ---
    const buildings = of('building');
    const oldTown = buildings.filter((b) => /victorian|storybook|fairy|cottage|mansion|tudor|timber|chalet|cabin/i.test(b.title));
    const eastern = buildings.filter((b) => /japanese|asian|chinese|korean|shrine|pagoda|inn\b|tatami|oriental/i.test(b.title));
    const grand = buildings.filter((b) => /cathedral|castle|manor|mansion|tower|windmill|church/i.test(b.title));
    const anyHouse = buildings.length ? buildings : [];
    const pick = <T>(arr: T[], i: number): T => arr[i % arr.length]!;

    const stalls = of('stall');
    const lanterns = of('lantern');
    const fountains = of('fountain');
    const wells = of('well');
    const bridges = of('bridge');
    const gates = of('gate').filter((g) => /gatehouse|archway|torii/i.test(g.title));
    const landmarks = of('landmark').filter(
      (l) => /sculpture|statue|moai|buddha|obelisk|stele|rune|totem|monument/i.test(l.title) && !/pedestal|plinth|driftwood|figurine|gravestone/i.test(l.title),
    );
    const trees = of('tree');
    const plants = of('plant');
    const crates = of('crate');
    const signposts = of('signpost');
    const carts = of('cart');
    const balloons = byTitle(/balloon/i);
    const npcs = of('npc');
    const horses = of('horse');
    const dogs = of('creature').filter((c) => /dog|retriever|spaniel|corgi|terrier|shepherd|pug|hound/i.test(c.title));
    const wildlife = of('creature').filter((c) => !dogs.includes(c));

    this.heroPool = (npcs.length ? npcs : dogs).map((c) => c.id);

    // --- the plaza: fountain centrepiece, lantern ring, signs, a couple of stalls ---
    // plain stone fountains compile cleanest — ornate ones bake to mush up close
    const plazaFountain =
      fountains.find((f) => /^two-tier stone garden fountain/i.test(f.title)) ??
      fountains.find((f) => /stone.*fountain/i.test(f.title)) ??
      fountains[0];
    if (plazaFountain) solid(plazaFountain, 0, 0, 0, 1, 0.7);
    if (lanterns.length) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + 0.26;
        const x = Math.cos(a) * (PLAZA_R - 2.5);
        const z = Math.sin(a) * (PLAZA_R - 2.5);
        place(pick(lanterns, i), x, z, a + Math.PI, 1);
        this.lampPosts.push({ x, z });
      }
    }
    signposts.slice(0, 2).forEach((s, i) => place(s, i ? 5 : -5, i ? -4 : 4, rnd() * TAU, 1));
    stalls.slice(0, 2).forEach((s, i) => solid(s, i ? 9 : -9, i ? 6.5 : -6.5, i ? -1.9 : 1.2, 1));

    // --- an avenue of buildings: fronts face the street, lanterns pace the kerb ---
    const lineAvenue = (
      pool: CatalogEntry[],
      axis: 'n' | 's' | 'e' | 'w',
      from: number,
      to: number,
      pitch: number,
      setback: number,
    ): void => {
      if (!pool.length) return;
      let i = 0;
      for (let d = from; d <= to; d += pitch) {
        for (const side of [-1, 1]) {
          const e = pick(pool, i++);
          const off = side * (setback + e.size * 0.42);
          const [x, z] = axis === 'n' ? [off, d] : axis === 's' ? [off, -d] : axis === 'e' ? [d, off] : [-d, off];
          if (blocked(x, z, 1)) continue;
          const face = axis === 'n' || axis === 's' ? (off > 0 ? -TAU / 4 : TAU / 4) : off > 0 ? Math.PI : 0;
          solid(e, x, z, face + (rnd() - 0.5) * 0.06, 0.92 + rnd() * 0.14);
        }
      }
    };
    const paceLamps = (axis: 'n' | 's' | 'e' | 'w', from: number, to: number, pitch: number, kerb: number): void => {
      if (!lanterns.length) return;
      let i = 0;
      for (let d = from; d <= to; d += pitch) {
        const side = i % 2 === 0 ? 1 : -1; // alternate kerbs
        const off = side * kerb;
        const [x, z] = axis === 'n' ? [off, d] : axis === 's' ? [off, -d] : axis === 'e' ? [d, off] : [-d, off];
        place(pick(lanterns, i++), x, z, 0, 1);
        this.lampPosts.push({ x, z });
      }
    };

    // North: Old Town — dense storybook houses up to the grand landmark vista
    lineAvenue(oldTown.length ? oldTown : anyHouse, 'n', PLAZA_R + 5, 52, 11, 8.2);
    paceLamps('n', PLAZA_R + 2, 54, 13, 4.2);
    if (grand[0]) solid(grand[0], 0, 66, Math.PI, 1.5, 0.7); // terminates the avenue

    // East: the Shrine Quarter — Asian houses, stone lanterns, a gate at the entry
    if (gates[0]) place(gates[0], PLAZA_R + 3, 0, TAU / 4, 1.2);
    lineAvenue(eastern.length ? eastern : anyHouse, 'e', PLAZA_R + 8, 52, 12, 8.4);
    paceLamps('e', PLAZA_R + 4, 54, 10, 4.2);

    // South: Market Street — stalls, shops, crates, a well
    lineAvenue(anyHouse, 's', PLAZA_R + 5, 40, 12, 8.4);
    stalls.slice(2).forEach((s, i) => solid(s, (i % 2 ? 4.6 : -4.6), -(PLAZA_R + 7 + i * 7), i % 2 ? -1.7 : 1.4, 1));
    crates.forEach((c, i) => {
      const x = (i % 2 ? 6.3 : -6.3) + (rnd() - 0.5) * 1.5;
      const z = -(PLAZA_R + 5 + ((i * 5.1) % 34));
      if (!blocked(x, z, 0.5)) place(c, x, z, rnd() * TAU, 1);
    });
    if (wells[0]) solid(wells[0], 6.5, -46, 0, 1.1);
    paceLamps('s', PLAZA_R + 2, 44, 12, 4.2);

    // West: the Garden District — gazebos, fountains, bridges, flower beds
    lineAvenue(
      buildings.filter((b) => /gazebo|pavilion|shed|greenhouse/i.test(b.title)),
      'w',
      PLAZA_R + 7,
      50,
      13,
      7,
    );
    fountains.slice(1, 3).forEach((f, i) => solid(f, -(26 + i * 16), i % 2 ? 8 : -8, 0, 1.1, 0.7));
    bridges.slice(0, 2).forEach((b, i) => place(b, -(34 + i * 14), i % 2 ? -11 : 11, TAU / 4, 1));
    if (plants.length) {
      for (const t of scatterPoints(46, PLAZA_R, 1313, (x, z) => x > -12 || blocked(x, z, 1) || roadDist(x, z) < 1)) {
        place(pick(plants, Math.abs(Math.round(t.x * 3 + t.z)) % plants.length), t.x, t.z, t.rot, 0.8 + t.scale * 0.5);
      }
    }
    paceLamps('w', PLAZA_R + 4, 52, 12, 4.2);

    // --- the ring road: houses face inward around the whole city ---
    if (anyHouse.length) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU + 0.13;
        const r = 58 + 6.5;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        if (blocked(x, z, 1)) continue;
        solid(pick(anyHouse, i * 3 + 1), x, z, Math.atan2(-x, -z), 1.1);
      }
    }

    // --- landmarks: curiosities scattered where wanderers find them ---
    landmarks.forEach((l, i) => {
      const a = i * 2.39996; // golden angle — even spread, no rings
      const r = 24 + ((i * 13.7) % 80);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (blocked(x, z) || roadDist(x, z) < 1.5) return;
      place(l, x, z, a + Math.PI, 1);
    });

    // --- the countryside: a forest ring beyond the city, meadow clearings inside ---
    if (trees.length) {
      for (const t of scatterPoints(150, 62, 77, (x, z) => blocked(x, z, 2) || roadDist(x, z) < 2.5)) {
        place(pick(trees, Math.abs(Math.round(t.x + t.z * 7))), t.x, t.z, t.rot, 0.9 + t.scale * 0.7);
      }
      // park trees inside the ring, sparse
      for (const t of scatterPoints(26, PLAZA_R + 6, 991, (x, z) => Math.hypot(x, z) > 54 || blocked(x, z, 2) || roadDist(x, z) < 2.5)) {
        place(pick(trees, Math.abs(Math.round(t.x * 3 - t.z))), t.x, t.z, t.rot, 0.8 + t.scale * 0.6);
      }
    }

    // --- hot-air balloons drifting high over the city (pure atmosphere) ---
    balloons.slice(0, 3).forEach((b, i) => {
      const a = i * 2.1 + 0.5;
      const r = 34 + i * 16;
      place(b, Math.cos(a) * r, Math.sin(a) * r, rnd() * TAU, 2.6, 26 + i * 8);
    });

    // --- street life: pedestrians on the avenues, carts on the ring, dogs, wildlife ---
    const spawnCreature = (mesh: string, x: number, z: number, speed: number, onRoads: boolean): void => {
      this.creatures.push({
        id: this.nextId++,
        name: '',
        mesh,
        x,
        z,
        yaw: rnd() * TAU,
        moving: false,
        isPlayer: false,
        tx: x,
        tz: z,
        speed,
        onRoads,
      });
    };
    npcs.slice(0, 34).forEach((n) => {
      const p = roadPoint(rnd);
      spawnCreature(n.id, p.x, p.z, 0.9 + rnd() * 0.8, true); // strolling townsfolk
    });
    carts.slice(0, 5).forEach((c) => {
      const p = roadPoint(rnd);
      spawnCreature(c.id, p.x, p.z, 2.4 + rnd() * 0.8, true); // rickshaw "traffic"
    });
    dogs.slice(0, 8).forEach((d) => {
      const p = roadPoint(rnd);
      spawnCreature(d.id, p.x, p.z, 2 + rnd() * 1.4, true); // street dogs
    });
    [...horses.slice(0, 7), ...wildlife.slice(0, 8)].forEach((h) => {
      const a = rnd() * TAU;
      const r = 64 + rnd() * 40;
      spawnCreature(h.id, Math.cos(a) * r, Math.sin(a) * r, 1.3 + rnd(), false); // countryside
    });
  }

  join(name: string): Player {
    const id = this.nextId++;
    const a = Math.random() * TAU;
    const rad = 4 + Math.random() * 5;
    const p: Player = {
      id,
      name,
      mesh: this.heroPool.length ? this.heroPool[id % this.heroPool.length]! : (this.catalog[0]?.id ?? ''),
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
        this.creatures.push({ ...a, isPlayer: false, tx: a.x, tz: a.z, speed: 0, onRoads: false });
      }
    }
  }

  step(a: Agent, dx: number, dz: number): void {
    const b = WORLD_HALF - 2;
    const nx = Math.min(b, Math.max(-b, a.x + dx));
    const nz = Math.min(b, Math.max(-b, a.z + dz));
    for (const bld of this.buildings) {
      const after = Math.hypot(nx - bld.x, nz - bld.z);
      if (after >= bld.r) continue;
      // block entry, but always allow moving OUT of an overlap — nobody gets stuck
      const before = Math.hypot(a.x - bld.x, a.z - bld.z);
      if (after <= before) return;
    }
    a.x = nx;
    a.z = nz;
  }

  groundAt(x: number, z: number): number {
    return heightAt(x, z);
  }

  /** The named part of the city you're standing in (shown in the HUD, GTA-style). */
  districtAt(x: number, z: number): string {
    const r = Math.hypot(x, z);
    if (r < PLAZA_R + 2) return 'GRAND PLAZA';
    if (r < 62) {
      if (Math.abs(z) >= Math.abs(x)) return z > 0 ? 'OLD TOWN' : 'MARKET STREET';
      return x > 0 ? 'SHRINE QUARTER' : 'GARDEN DISTRICT';
    }
    return 'THE WILDS';
  }

  tick(dt: number): void {
    for (const c of this.creatures) {
      const dx = c.tx - c.x;
      const dz = c.tz - c.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.3) {
        for (let t = 0; t < 6; t++) {
          if (c.onRoads) {
            // stroll the street network: next stop is a nearby point on some road
            const p = roadPoint(Math.random);
            if (Math.hypot(p.x - c.x, p.z - c.z) < 46) {
              c.tx = p.x;
              c.tz = p.z;
              break;
            }
          } else {
            const nx = c.x + (Math.random() * 2 - 1) * 26;
            const nz = c.z + (Math.random() * 2 - 1) * 26;
            if (Math.abs(nx) < WORLD_HALF - 5 && Math.abs(nz) < WORLD_HALF - 5) {
              c.tx = nx;
              c.tz = nz;
              break;
            }
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
