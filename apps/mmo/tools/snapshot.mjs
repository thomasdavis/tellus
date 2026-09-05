// Render the world to a PNG so we can actually see how it looks.
import { createRequire } from 'node:module';
import { RasterTarget } from '@tellus/engine';
import { World } from '../src/world/world.js';
import { WorldRenderer } from '../src/render/renderer.js';
import { DAY_LENGTH } from '../src/nature/daynight.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const OUT = process.argv[2] || '/tmp/mmo-shot.png';
const W = 720;
const H = 400;

const world = new World();
const you = world.join('YOU');
you.x = 0;
you.z = 0;
you.yaw = 0.4;
const renderer = new WorldRenderer(world);
// optional phase arg (0..1) to preview a time of day
const phase = process.argv[4] !== undefined ? parseFloat(process.argv[4]) : undefined;
if (phase !== undefined) renderer.start = Date.now() - ((phase - 0.3) * DAY_LENGTH) * 1000;
const target = new RasterTarget(W, H);

const gy = world.groundAt(0, 0);
const mode = process.argv[3] || 'aerial';
const eye = mode === 'pov' ? [-6.5, gy + 4.2, -11] : mode === 'street' ? [1.8, world.groundAt(1.8, -30) + 2.4, -30] : [-32, gy + 22, -32];
const look = mode === 'pov' ? [3, gy + 1.1, 12] : mode === 'street' ? [0, gy + 1.8, 20] : [4, gy + 2, 5];
renderer.render(target, world, you.id, eye, look, 120, 40);

await sharp(Buffer.from(target.rgb), { raw: { width: W, height: H, channels: 3 } })
  .png()
  .toFile(OUT);
console.log('wrote', OUT);
