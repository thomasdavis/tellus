import { Canvas } from '@react-three/fiber';
import type { ModelEntry } from '@tellus/assets';
import type { NetClient } from '../net/NetClient.js';
import { Scene } from './Scene.js';

export function GameCanvas({
  net,
  characters,
  worldProps,
}: {
  net: NetClient;
  characters: ModelEntry[];
  worldProps: ModelEntry[];
}) {
  return (
    <Canvas shadows dpr={[1, 1.75]} camera={{ position: [0, 7, 12], fov: 52 }}>
      <Scene net={net} characters={characters} worldProps={worldProps} />
    </Canvas>
  );
}
