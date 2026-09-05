// Full per-frame pipeline bench: render3d -> octant fit -> ANSI diff.
// The plain bench only times the rasterizer; production also pays the encode+diff.
import { RasterTarget, Screen, diffToAnsi, fbSize } from '@tellus/engine';
import { World } from '../src/world/world.js';
import { WorldRenderer } from '../src/render/renderer.js';

const world = new World();
const p = world.join('BENCH');
p.x = 0; p.z = 0;
const r = new WorldRenderer(world);

for (const [cols, rows] of [[100, 30], [150, 46]]) {
  const [fbW, fbH] = fbSize('octant', cols, rows);
  const target = new RasterTarget(fbW, fbH);
  const cur = new Screen(cols, rows);
  const prev = new Screen(cols, rows);
  const eye = [-6.5, world.groundAt(0, 0) + 4.2, -11];
  const look = [3, world.groundAt(0, 0) + 1.1, 12];

  const N = 60;
  let tRender = 0, tFit = 0, tDiff = 0;
  // warm
  r.render(target, world, p.id, eye, look, cols, rows);
  cur.setFromFramebuffer(target.rgb, fbW, fbH, 'octant', 28);
  diffToAnsi(cur, prev, true);

  for (let i = 0; i < N; i++) {
    let a = performance.now();
    r.render(target, world, p.id, eye, look, cols, rows);
    let b = performance.now(); tRender += b - a;
    cur.setFromFramebuffer(target.rgb, fbW, fbH, 'octant', 28);
    let c = performance.now(); tFit += c - b;
    diffToAnsi(cur, prev, false);
    tDiff += performance.now() - c;
    world.tick(0.033);
  }
  const R = (x) => (x / N).toFixed(1);
  const tot = (tRender + tFit + tDiff) / N;
  console.log(`${cols}x${rows}: render ${R(tRender)}  fit ${R(tFit)}  diff ${R(tDiff)}  = ${tot.toFixed(1)} ms/frame  (${(1000 / tot).toFixed(0)} fps ceiling)`);
}
