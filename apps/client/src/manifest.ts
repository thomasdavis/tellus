import type { Manifest } from '@tellus/assets';

/** Load the avatar/prop manifest produced by `pnpm assets`. */
export async function loadManifest(): Promise<Manifest> {
  const res = await fetch('/models/manifest.json');
  if (!res.ok) {
    throw new Error('No asset manifest found. Run `pnpm assets` at the repo root first.');
  }
  return (await res.json()) as Manifest;
}
