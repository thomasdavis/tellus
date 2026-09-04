import { Suspense, useEffect, useState } from 'react';
import { OrbitControls } from '@react-three/drei';
import type { ModelEntry } from '@tellus/assets';
import type { NetClient } from '../net/NetClient.js';
import { Ground } from './Ground.js';
import { Props } from './Props.js';
import { LocalPlayer } from './LocalPlayer.js';
import { RemotePlayer } from './RemotePlayer.js';

function urlFor(id: string | undefined, chars: ModelEntry[]): string | undefined {
  const e = (id && chars.find((c) => c.id === id)) || chars[0];
  return e?.glb;
}

export function Scene({
  net,
  characters,
  worldProps,
}: {
  net: NetClient;
  characters: ModelEntry[];
  worldProps: ModelEntry[];
}) {
  const [ids, setIds] = useState<number[]>([]);
  useEffect(() => {
    const sync = (): void => setIds([...net.remotes.keys()]);
    sync();
    return net.on((e) => {
      if (e.type === 'players' || e.type === 'welcome' || e.type === 'disconnect') sync();
    });
  }, [net]);

  const selfUrl = urlFor(net.self?.character, characters);

  return (
    <>
      <color attach="background" args={['#acd3e6']} />
      <fog attach="fog" args={['#acd3e6', 70, 200]} />
      <hemisphereLight args={['#ffffff', '#6b7b5a', 1.0]} />
      <directionalLight
        position={[40, 60, 25]}
        intensity={1.5}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-far={220}
      />
      <Ground half={net.worldHalf} />
      <Props props={worldProps} half={net.worldHalf} />
      <Suspense fallback={null}>
        <LocalPlayer net={net} url={selfUrl} />
      </Suspense>
      {ids.map((id) => (
        <Suspense key={id} fallback={null}>
          <RemotePlayer net={net} id={id} url={urlFor(net.remotes.get(id)?.character, characters)} />
        </Suspense>
      ))}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.12}
        minDistance={4}
        maxDistance={22}
        maxPolarAngle={Math.PI * 0.49}
      />
    </>
  );
}
