// Harvest the WHOLE Flobots library (all pages), keep everything that can live in
// an open-world city — buildings, market stalls, lanterns, fountains, bridges,
// gates, landmarks, flora, characters, creatures, carts — and compile each to a
// high-quality engine mesh + a catalog the world builder reads.
// Run: node convert-all.mjs
import { execFile } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const MESH_DIR = join(HERE, '../assets/meshes');
const COMPILER = join(ROOT, 'packages/engine/tools/compile-glb.mjs');
const TMP = '/tmp/flobots-glb';
const API = 'https://3d.flobots.xyz';
const UA = 'tellus-mmo/0.3';

// How many of each kind the city can use — keeps the harvest big but purposeful.
const CAPS = {
  building: 70, stall: 8, lantern: 16, fountain: 8, well: 4, bridge: 8, gate: 12,
  landmark: 30, tree: 60, plant: 70, npc: 70, creature: 45, horse: 12, cart: 8,
  balloon: 4, boat: 6, crate: 14, signpost: 8, prop: 20,
};

/** Role + world-size (longest horizontal extent, metres). null = not city material. */
function classify(m) {
  const title = (m.ai_title || m.name || '').trim();
  if (!title || /gradio export/i.test(title)) return null; // raw AI export, not content
  const cat = (m.asset_category || '').toLowerCase();
  const hay = `${title} ${cat} ${(m.ai_tags || []).join(' ')}`.toLowerCase();

  // Interiors, furniture, architectural fragments and trinkets can't stand in a street.
  if (/\b(interior|diorama|room\b|kitchen|bedroom|parlor|study|dollhouse|door|doorway|window|shutter|capital\b|cornice|molding|moulding|staircase|balustrade|sofa|couch|stool|armchair|table|desk|cabinet|shelf|bed\b|vase|jewelry|treasure|orb\b|coin|skull|abstract|number \d|wall art|frame\b|mirror|rug\b|curtain|lamp shade|rocket|spaceship|fish rocket)\b/.test(hay))
    return null;

  if (/\b(market stall|stall)\b/.test(hay)) return { kind: 'stall', size: 4 };
  if (/\blantern\b/.test(hay)) return { kind: 'lantern', size: 1.3 };
  if (/\bfountain\b/.test(hay)) return { kind: 'fountain', size: 4.5 };
  if (/\bwell\b/.test(hay)) return { kind: 'well', size: 3 };
  if (/\bbridge\b/.test(hay)) return { kind: 'bridge', size: 6 };
  if (/\b(gate(house)?|archway|torii|portal)\b/.test(hay)) return { kind: 'gate', size: 5 };
  if (/\b(cart|wagon|rickshaw|trishaw|carriage|wheelbarrow)\b/.test(hay)) return { kind: 'cart', size: 3 };
  if (/\bballoon\b/.test(hay)) return { kind: 'balloon', size: 3 };
  if (/\b(rowboat|sailboat|galleon|boat)\b/.test(hay)) return { kind: 'boat', size: 4 };
  if (/\b(crate|barrel)\b/.test(hay)) return { kind: 'crate', size: 1.2 };
  if (/\b(signpost|sign post)\b/.test(hay)) return { kind: 'signpost', size: 1.6 };

  if (/\b(house|cottage|mansion|cabin|hut|inn\b|shrine|temple|pavilion|gazebo|chalet|windmill|shop house|garden shed|tower|castle|church|cathedral|barn)\b/.test(hay))
    return { kind: 'building', size: /mansion|castle|cathedral|manor|tower/.test(hay) ? 13 : 9 };

  if (/\b(horse|zebra|pony|stallion|mare|clydesdale|friesian|draft|appaloosa|pinto|unicorn)\b/.test(hay))
    return { kind: 'horse', size: 2.5 };
  if (cat === 'fauna' || /\b(dog|hound|puppy|terrier|retriever|corgi|pug|cat\b|bird|fox|deer|rabbit|creature|beast|dragon)\b/.test(hay))
    return { kind: 'creature', size: 1.5 };
  if (cat === 'person' || /\b(person|character|humanoid|knight|hero|warrior|mage|druid|valkyrie|android|robot|empress|guardian|girl|boy|man\b|woman)\b/.test(hay))
    return { kind: 'npc', size: 1.85 };

  if (/\b(tree|pine|oak|palm|maple|willow|birch|bamboo|bonsai)\b/.test(hay)) return { kind: 'tree', size: 6 };
  if (cat === 'flora' || /\b(flower|bush|shrub|plant|fern|mushroom|hedge|topiary|succulent|cactus)\b/.test(hay))
    return { kind: 'plant', size: 1.2 };

  if (/\b(statue|sculpture|monument|sphinx|obelisk|pagoda|pillar|column|ruin)\b/.test(hay))
    return { kind: 'landmark', size: 5 };
  if (cat === 'prop' || cat === 'environment') return { kind: 'prop', size: 2 };
  return null;
}

const exists = (p) => stat(p).then(() => true, () => false);

async function download(id, dest) {
  const res = await fetch(`${API}/api/download/${id}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function fetchAllModels() {
  const first = await (await fetch(`${API}/api/models?per_page=100&page=1`, { headers: { 'user-agent': UA } })).json();
  const pages = first.pagination?.pages ?? 1;
  let all = first.models ?? [];
  for (let p = 2; p <= pages; p++) {
    const body = await (await fetch(`${API}/api/models?per_page=100&page=${p}`, { headers: { 'user-agent': UA } })).json();
    all = all.concat(body.models ?? []);
  }
  return all;
}

async function main() {
  await mkdir(MESH_DIR, { recursive: true });
  await mkdir(TMP, { recursive: true });
  const all = await fetchAllModels();
  const classified = all.map((m) => ({ m, c: classify(m) })).filter((x) => x.c);

  // cap per kind (keep library order = curation order)
  const counts = {};
  const relevant = classified.filter(({ c }) => {
    counts[c.kind] = (counts[c.kind] || 0) + 1;
    return counts[c.kind] <= (CAPS[c.kind] ?? 0);
  });
  console.log(`▸ ${all.length} models in library → ${classified.length} city-relevant → ${relevant.length} after caps`);

  const catalog = [];
  let ok = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < relevant.length) {
      const { m, c } = relevant[cursor++];
      const meshPath = join(MESH_DIR, `${m.id}.mesh.json`);
      try {
        if (!(await exists(meshPath))) {
          const glb = join(TMP, `${m.id}.glb`);
          if (!(await exists(glb))) await download(m.id, glb);
          await run('node', [COMPILER, glb, MESH_DIR, m.id, String(c.size)], { maxBuffer: 96 * 1024 * 1024 });
        }
        catalog.push({ id: m.id, title: (m.ai_title || m.name || '').trim(), kind: c.kind, size: c.size });
        ok++;
        if (ok % 20 === 0) console.log(`  … ${ok}/${relevant.length}`);
      } catch (e) {
        console.warn(`  ✗ ${(m.ai_title || m.id).slice(0, 40)} — ${String(e.message).slice(0, 50)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  // stable order — workers finish in race order, but the city layout keys off this file
  catalog.sort((a, b) => a.kind.localeCompare(b.kind) || (a.title || '').localeCompare(b.title || '') || a.id.localeCompare(b.id));
  await writeFile(join(MESH_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
  const byKind = catalog.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {});
  console.log(`\n✔ ${ok} models compiled → ${MESH_DIR}`);
  console.log(`  ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
