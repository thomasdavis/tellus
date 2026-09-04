/**
 * Pulls the Flobots 3D Asset Manager library into the client's public dir and
 * writes a runtime manifest. Idempotent: already-downloaded files are skipped, so
 * re-running only fetches what's new. Run with `pnpm assets` from the repo root.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, type RawModel } from './classify.js';
import type { Manifest, ModelEntry } from './types.js';

const SOURCE = process.env.FLOBOTS_URL ?? 'https://3d.flobots.xyz';
const UA = 'tellus-asset-pipeline/0.1 (+https://sshfighter.com)';
const CONCURRENCY = 4;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const OUT_DIR = join(REPO_ROOT, 'apps/client/public/models');

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

interface Binary {
  buf: Buffer;
  contentType: string | null;
}

async function fetchBinary(url: string): Promise<Binary | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`${res.status}`);
      return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
    } catch (err) {
      if (attempt === 3) {
        console.warn(`  ! failed ${url}: ${(err as Error).message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  return null;
}

async function pool<T>(items: T[], n: number, worker: (t: T, i: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
}

async function main(): Promise<void> {
  console.log(`▸ fetching model index from ${SOURCE}/api/models`);
  const raw = await getJSON<RawModel[] | { models?: RawModel[]; data?: RawModel[] }>(`${SOURCE}/api/models`);
  const models: RawModel[] = Array.isArray(raw) ? raw : (raw.models ?? raw.data ?? []);
  console.log(`  found ${models.length} models`);

  await mkdir(OUT_DIR, { recursive: true });
  const entries: ModelEntry[] = [];

  await pool(models, CONCURRENCY, async (m) => {
    const c = classify(m);
    const glbPath = join(OUT_DIR, `${m.id}.glb`);
    if (!(await exists(glbPath))) {
      const glb = await fetchBinary(`${SOURCE}/api/model/${m.id}/game-optimized`);
      if (!glb) {
        console.warn(`  ✗ skip ${c.title} (no GLB)`);
        return;
      }
      await writeFile(glbPath, glb.buf);
    }

    let thumb: string | null = null;
    const t = await fetchBinary(`${SOURCE}/api/model/${m.id}/thumbnail`);
    if (t) {
      const ext = EXT_BY_TYPE[(t.contentType ?? '').split(';')[0]!.trim()] ?? 'png';
      await writeFile(join(OUT_DIR, `${m.id}.${ext}`), t.buf);
      thumb = `/models/${m.id}.${ext}`;
    }

    entries.push({
      id: m.id,
      title: c.title,
      category: c.category,
      tags: c.tags,
      kind: c.kind,
      glb: `/models/${m.id}.glb`,
      thumb,
    });
    console.log(`  ✓ ${c.kind.padEnd(9)} ${c.title.slice(0, 40)}`);
  });

  const manifest: Manifest = {
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    characters: entries.filter((e) => e.kind === 'character'),
    props: entries.filter((e) => e.kind === 'prop'),
  };
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(
    `\n✔ ${entries.length} assets → ${OUT_DIR}\n  ${manifest.characters.length} characters · ${manifest.props.length} props`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
