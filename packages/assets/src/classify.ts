import type { ModelKind } from './types.js';

const FURNITURE = /(sofa|couch|chair|throne|stool|table|desk|lamp|sculpture|tree|plant|bench|shelf|rug|building|wall|floor)/i;
const CREATURE = /(dog|hound|cat|puppy|papillon|maltese|spaniel|creature|beast|cyborg|robot|dragon|fox|wolf|bird|character|avatar|humanoid|person|knight)/i;

export interface RawModel {
  id: string;
  ai_title?: string;
  name?: string;
  original_filename?: string;
  asset_category?: string;
  ai_tags?: unknown;
  tags?: unknown;
}

const toTags = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

export interface Classified {
  title: string;
  category: string;
  tags: string[];
  kind: ModelKind;
}

/**
 * Best-effort split of a mixed asset library into "things you can be" and "things
 * that dress the world". Furniture words win first (a *wooden dog sculpture* is a
 * prop, not a pet); creatures become characters; anything unlabelled defaults to a
 * character so the world's mystery meshes are at least playable. It's all data —
 * fix a miscategorised asset by editing the generated manifest.
 */
export function classify(m: RawModel): Classified {
  const title = (m.ai_title || m.name || m.original_filename || m.id).trim();
  const category = (m.asset_category || 'unknown').trim();
  const tags = [...toTags(m.ai_tags), ...toTags(m.tags)];
  const haystack = `${title} ${category} ${tags.join(' ')}`;

  const kind: ModelKind = FURNITURE.test(haystack)
    ? 'prop'
    : CREATURE.test(haystack)
      ? 'character'
      : 'character';

  return { title, category, tags, kind };
}
