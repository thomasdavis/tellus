import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group } from 'three';
import { INTERP_DELAY } from '../config.js';
import type { NetClient } from '../net/NetClient.js';
import { sampleRemote } from '../net/interp.js';
import { Avatar } from './Avatar.js';
import { NameTag } from './NameTag.js';

/** Another player, rendered slightly in the past and interpolated between the
 *  snapshots the server streamed for them. */
export function RemotePlayer({ net, id, url }: { net: NetClient; id: number; url: string | undefined }) {
  const group = useRef<Group>(null);
  const anim = useRef(0);

  useFrame(() => {
    const r = net.remotes.get(id);
    if (!r || !group.current) return;
    const pose = sampleRemote(r.buf, performance.now() / 1000 - INTERP_DELAY);
    if (pose) {
      group.current.position.set(pose.x, 0, pose.z);
      group.current.rotation.y = pose.yaw;
      anim.current = pose.anim;
    }
  });

  const r = net.remotes.get(id);
  return (
    <group ref={group}>
      {url && <Avatar url={url} getAnim={() => anim.current} size={1.7} fit="height" />}
      <Html position={[0, 2.1, 0]} center distanceFactor={12} zIndexRange={[10, 0]}>
        <NameTag name={r?.name ?? '…'} />
      </Html>
    </group>
  );
}
