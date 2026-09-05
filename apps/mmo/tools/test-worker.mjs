// Verify a render worker's output is byte-identical to the inline renderer for the
// same world snapshot, camera, and time. If this passes, the pool is a safe swap.
import { RasterTarget, Screen, fbSize } from '@tellus/engine';
import { World } from '../src/world/world.js';
import { WorldRenderer } from '../src/render/renderer.js';
import { RenderPool } from '../src/render/pool.js';

const cols = 120, rows = 40, mode = 'octant', tSec = 42.0, viewerId = 999;
const eye = [-6.5, 0, -11], look = [3, 0, 12];

// --- inline reference ---
const world = new World();
const me = world.join('TESTER');
me.x = 0; me.z = 0; me.yaw = 0.4;
eye[1] = world.groundAt(0, 0) + 4.2; look[1] = world.groundAt(0, 0) + 1.1;
const snap = world.snapshot();

const renderer = new WorldRenderer(world);
const [fbW, fbH] = fbSize(mode, cols, rows);
const target = new RasterTarget(fbW, fbH);
world.applySnapshot(snap);
const tagsA = renderer.render(target, world, viewerId, eye, look, cols, rows, tSec);
const A = new Screen(cols, rows);
A.setFromFramebuffer(target.rgb, fbW, fbH, mode, 12);

// --- worker ---
const pool = new RenderPool(1);
const t0 = Date.now();
while (pool.readySize === 0 && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));
console.log(`worker ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const B = await pool.render({ viewerId, eye, look, cols, rows, mode, tSec, agents: snap });

let dch = 0, dfg = 0, dbg = 0;
for (let i = 0; i < cols * rows; i++) {
  if (A.ch[i] !== B.ch[i]) dch++;
  if (A.fg[i] !== B.fg[i]) dfg++;
  if (A.bg[i] !== B.bg[i]) dbg++;
}
console.log(`cells: ${cols * rows}  ch-diff: ${dch}  fg-diff: ${dfg}  bg-diff: ${dbg}`);
console.log(`tags inline: ${tagsA.length}  worker: ${B.tags.length}`);
console.log(dch === 0 && dfg === 0 && dbg === 0 ? 'IDENTICAL ✓' : 'MISMATCH ✗');
pool.close();
process.exit(0);
