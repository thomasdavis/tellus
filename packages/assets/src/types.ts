/** Whether an asset is something you play AS, or something the world is decorated WITH. */
export type ModelKind = 'character' | 'prop';

/** One resolved, downloaded model, as recorded in the runtime manifest. */
export interface ModelEntry {
  id: string;
  title: string;
  category: string;
  tags: string[];
  kind: ModelKind;
  /** Public URL of the game-optimized GLB, served from the client's /models dir. */
  glb: string;
  /** Public URL of the thumbnail, or null if none was available. */
  thumb: string | null;
}

/** The manifest the client loads at runtime to know what avatars & props exist. */
export interface Manifest {
  source: string;
  generatedAt: string;
  characters: ModelEntry[];
  props: ModelEntry[];
}
