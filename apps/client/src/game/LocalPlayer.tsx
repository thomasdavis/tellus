import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group } from 'three';
import type { NetClient } from '../net/NetClient.js';
import { Avatar } from './Avatar.js';
import { NameTag } from './NameTag.js';
import { isTyping, useKeyboard } from './useKeyboard.js';

/**
 * You. Reads the keyboard, derives a camera-relative move intent, predicts your
 * motion through the shared integrator (inside NetClient) every frame, and keeps
 * the orbit camera trained on your avatar.
 */
export function LocalPlayer({ net, url }: { net: NetClient; url: string | undefined }) {
  const keys = useKeyboard();
  const group = useRef<Group>(null);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target: { set: (x: number, y: number, z: number) => void }; update?: () => void } | null;

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const k = keys.current;
    const typing = isTyping();
    let f = 0;
    let r = 0;
    if (!typing) {
      if (k['KeyW'] || k['ArrowUp']) f += 1;
      if (k['KeyS'] || k['ArrowDown']) f -= 1;
      if (k['KeyD'] || k['ArrowRight']) r += 1;
      if (k['KeyA'] || k['ArrowLeft']) r -= 1;
    }
    const run = !typing && (k['ShiftLeft'] || k['ShiftRight'] || false);

    // camera-relative facing: forward points from the camera toward the player
    const yaw = Math.atan2(net.local.x - camera.position.x, net.local.z - camera.position.z);
    net.applyInput({ f, r, yaw, run, dt });

    if (group.current) {
      group.current.position.set(net.local.x, 0, net.local.z);
      group.current.rotation.y = net.local.yaw;
    }
    if (controls) {
      controls.target.set(net.local.x, 1.2, net.local.z);
      controls.update?.();
    }
  });

  return (
    <group ref={group}>
      {url && <Avatar url={url} getAnim={() => net.local.anim} size={1.7} fit="height" />}
      <Html position={[0, 2.1, 0]} center distanceFactor={12} zIndexRange={[10, 0]}>
        <NameTag name={net.self?.name ?? 'you'} you />
      </Html>
    </group>
  );
}
