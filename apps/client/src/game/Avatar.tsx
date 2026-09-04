import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { Box3, type Group, Vector3 } from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Anim } from '@tellus/protocol';

interface AvatarProps {
  url: string;
  /** 'height' normalizes to `size` metres tall (avatars); 'max' fits the largest axis (props). */
  fit?: 'height' | 'max';
  size?: number;
  /** Live animation-state getter, so a single instance reflects motion without re-rendering. */
  getAnim?: () => number;
  /** Procedural idle/step bob. Off for inert props. */
  bob?: boolean;
}

/**
 * Loads a GLB, deep-clones it (so the same model can appear many times), and
 * normalizes its scale so wildly different source assets share a sane in-world
 * size with their feet on the ground. A cheap procedural bob stands in for real
 * animation clips until rigged avatars are wired up.
 */
export function Avatar({ url, fit = 'height', size = 1.6, getAnim, bob = true }: AvatarProps) {
  const { scene } = useGLTF(url);

  const object = useMemo(() => {
    const c = cloneSkeleton(scene);
    const box = new Box3().setFromObject(c);
    const dims = new Vector3();
    const center = new Vector3();
    box.getSize(dims);
    box.getCenter(center);
    const basis = fit === 'height' ? dims.y : Math.max(dims.x, dims.y, dims.z);
    const s = basis > 1e-4 ? size / basis : 1;
    c.scale.setScalar(s);
    c.position.set(-center.x * s, -box.min.y * s, -center.z * s);
    c.traverse((o) => {
      const mesh = o as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return c;
  }, [scene, fit, size]);

  const inner = useRef<Group>(null);
  useFrame((state) => {
    if (!bob || !inner.current) return;
    const anim = getAnim ? getAnim() : Anim.Idle;
    const moving = anim !== Anim.Idle;
    const amp = moving ? 0.07 : 0.02;
    const freq = anim === Anim.Run ? 13 : moving ? 8 : 2;
    inner.current.position.y = Math.abs(Math.sin(state.clock.elapsedTime * freq)) * amp;
  });

  return (
    <group ref={inner}>
      <primitive object={object} />
    </group>
  );
}
