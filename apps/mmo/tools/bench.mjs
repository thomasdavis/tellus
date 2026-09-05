import { RasterTarget } from '@tellus/engine';
import { World } from '../src/world/world.js';
import { WorldRenderer } from '../src/render/renderer.js';
import { fbSize } from '@tellus/engine';

const world = new World();
const p = world.join('BENCH');
p.x = 0; p.z = 0;
const r = new WorldRenderer(world);

for (const [cols, rows] of [[100, 30], [150, 46]]) {
  const [fbW, fbH] = fbSize('octant', cols, rows);
  const target = new RasterTarget(fbW, fbH);
  const eye = [-6.5, world.groundAt(0, 0) + 4.2, -11];
  const look = [3, world.groundAt(0, 0) + 1.1, 12];
  r.render(target, world, p.id, eye, look, cols, rows); // warm up
  const N = 60;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    r.render(target, world, p.id, eye, look, cols, rows);
    world.tick(0.033);
  }
  const ms = (performance.now() - t0) / N;
  console.log(`${cols}x${rows} (fb ${fbW}x${fbH}): ${ms.toFixed(1)} ms/frame  → max ${(1000 / ms).toFixed(0)} fps before it blocks input`);
}
