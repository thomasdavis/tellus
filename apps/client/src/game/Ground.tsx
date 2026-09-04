import { Grid } from '@react-three/drei';

/** The world floor: a soft green plane with a fading reference grid and a ring
 *  marking the playable bounds. */
export function Ground({ half }: { half: number }) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[half * 2, half * 2]} />
        <meshStandardMaterial color="#6f9e5e" roughness={1} />
      </mesh>
      <Grid
        args={[half * 2, half * 2]}
        cellSize={2}
        cellThickness={0.6}
        cellColor="#5c8a4d"
        sectionSize={10}
        sectionThickness={1.1}
        sectionColor="#3f6637"
        fadeDistance={120}
        fadeStrength={1.5}
        followCamera={false}
        infiniteGrid={false}
        position={[0, 0, 0]}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[half - 0.6, half, 96]} />
        <meshBasicMaterial color="#e9d27a" transparent opacity={0.5} />
      </mesh>
    </group>
  );
}
