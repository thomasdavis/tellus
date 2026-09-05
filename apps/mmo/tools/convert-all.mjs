// Pull the whole Flobots library, keep the game-relevant models, and compile each
// to a high-quality engine mesh + a catalog. Run: node convert-all.mjs
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
const UA = 'tellus-mmo/0.2';

/** Role + world-size (longest horizontal extent, metres) for a model. Anything
 *  without a real title is a raw AI export — not game content — and is skipped. */
function classify(m) {
  const title = (m.ai_title || m.name || '').trim();
  if (!title || /gradio export/i.test(title)) return null;
  const cat = (m.asset_category || '').toLowerCase();
  const hay = `${title} ${cat} ${(m.ai_tags || []).join(' ')}`.toLowerCase();
  if (/\b(house|cottage|mansion|cabin|hut|tower|castle|barn|church|shop|building)\b/.test(hay))
    return { kind: 'building', size: /mansion|castle|manor/.test(hay) ? 13 : 9 };
  if (/\b(horse|zebra|pony|stallion|mare|clydesdale|friesian|draft|appaloosa|pinto)\b/.test(hay))
    return { kind: 'horse', size: 2.5 };
  if (cat === 'fauna' || /\b(dog|hound|puppy|terrier|retriever|corgi|pug|cat|bird|animal|creature|beast)\b/.test(hay))
    return { kind: 'creature', size: 1.5 };
  if (cat === 'person' || /\b(person|character|humanoid|knight|hero|warrior|girl|boy|man|woman)\b/.test(hay))
    return { kind: 'hero', size: 1.85 };
  if (/\b(tree|pine|oak|flora|plant|bush|shrub|hedge|flower)\b/.test(hay)) return { kind: 'tree', size: 6 };
  if (/\b(sculpture|statue|monument|obelisk|fountain|well|pillar)\b/.test(hay)) return { kind: 'landmark', size: 3 };
  if (/\b(sofa|couch|chair|stool|table|cabinet|desk|bench|throne|lamp|bed|shelf|bust)\b/.test(hay))
    return { kind: 'prop', size: 2.2 };
  if (cat === 'vehicle' || /\b(cart|wagon|carriage|boat|vehicle)\b/.test(hay)) return { kind: 'vehicle', size: 3 };
  return { kind: 'prop', size: 2.2 };
}

const exists = (p) => stat(p).then(() => true, () => false);

async function download(id, dest) {
  const res = await fetch(`${API}/api/download/${id}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  await mkdir(MESH_DIR, { recursive: true });
  await mkdir(TMP, { recursive: true });
  const res = await fetch(`${API}/api/models?per_page=500`, { headers: { 'user-agent': UA } });
  const body = await res.json();
  const all = body.models ?? body.data ?? body;
  const relevant = all.map((m) => ({ m, c: classify(m) })).filter((x) => x.c);
  console.log(`▸ ${all.length} models in library → ${relevant.length} game-relevant`);

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
        catalog.push({ id: m.id, title: m.ai_title, kind: c.kind, size: c.size });
        ok++;
        if (ok % 8 === 0) console.log(`  … ${ok}/${relevant.length}`);
      } catch (e) {
        console.warn(`  ✗ ${(m.ai_title || m.id).slice(0, 40)} — ${String(e.message).slice(0, 50)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));

  await writeFile(join(MESH_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));
  const byKind = catalog.reduce((a, c) => ((a[c.kind] = (a[c.kind] || 0) + 1), a), {});
  console.log(`\n✔ ${ok} models compiled → ${MESH_DIR}`);
  console.log(`  ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' · ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
