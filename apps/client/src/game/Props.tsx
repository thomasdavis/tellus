import { Suspense, useMemo } from 'react';
import type { ModelEntry } from '@tellus/assets';
import { Anim } from '@tellus/protocol';
import { Avatar } from './Avatar.js';

interface Placed {
  key: string;
  url: string;
  pos: [number, number, number];
  rot: number;
}

/** Scatters the world props (trees, furniture, statuary) across the map on a
 *  deterministic golden-angle spiral, so the layout is stable between sessions. */
export function Props({ props, half }: { props: ModelEntry[]; half: number }) {
  const placed = useMemo<Placed[]>(() => {
    const out: Placed[] = [];
    const reach = half - 12;
    let i = 0;
    for (const p of props) {
      for (let k = 0; k < 3; k++) {
        const a = i * 2.399963; // golden angle
        const rad = 10 + ((i * 7) % Math.max(1, reach - 10));
        out.push({ key: `${p.id}-${k}`, url: p.glb, pos: [Math.cos(a) * rad, 0, Math.sin(a) * rad], rot: a });
        i++;
      }
    }
    return out;
  }, [props, half]);

  return (
    <>
      {placed.map((p) => (
        <Suspense key={p.key} fallback={null}>
          <group position={p.pos} rotation={[0, p.rot, 0]}>
            <Avatar url={p.url} fit="max" size={2.8} bob={false} getAnim={() => Anim.Idle} />
          </group>
        </Suspense>
      ))}
    </>
  );
}
