// Headless checks for the Ocarina movement kit: the camera drifts behind the
// direction of travel, Tab acquires (and releases) a lock on a nearby agent,
// and a roll covers meaningfully more ground than plain running.
import { PassThrough } from 'node:stream';
import { World } from '../src/world/world.js';
import { MmoSession } from '../src/session.js';

const world = new World();
const me = world.join('TESTER');
me.x = 2; // on the south avenue — open roadway, clear of collision circles
me.z = -20;

// a session with a stub renderer — we only exercise input + simulation
const stubRenderer = { start: Date.now(), render: () => [] };
const sess = new MmoSession(new PassThrough(), world, stubRenderer, me, 100, 30, null);

const DT = 1 / 30;
let now = Date.now();
// the session stamps input with Date.now(); keep it on the simulated clock
Date.now = () => now;
const step = (n) => {
  for (let i = 0; i < n; i++) {
    now += DT * 1000;
    sess.stepOnce(now, DT);
  }
};
const press = (k) => sess.onData(Buffer.from(k, 'latin1'));
const hold = (k, ticks) => {
  for (let i = 0; i < ticks; i++) {
    sess.press[k] = now;
    step(1);
  }
};

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failures++;
};

// 1. run forward: we move, and the camera settles behind the travel direction
const camYaw0 = sess.cam.yaw;
hold('w', 60); // 2s
const moved = Math.hypot(me.x, me.z);
check(`running moves the player (${moved.toFixed(1)}m in 2s)`, moved > 8);
hold('a', 30); // veer left 1s (carving), then straighten out —
hold('w', 60); // — the camera should settle in behind the run
const travel = Math.atan2(sess.dirX, sess.dirZ);
let diff = (travel - sess.cam.yaw) % (Math.PI * 2);
if (diff > Math.PI) diff -= Math.PI * 2;
if (diff < -Math.PI) diff += Math.PI * 2;
check(`camera follows the run (behind travel by ${Math.abs(diff).toFixed(2)} rad)`, Math.abs(diff) < 0.6);
check('camera actually turned from spawn', Math.abs(sess.cam.yaw - camYaw0) > 0.15);

// 2. Z-target: plant another player right in front of the camera and lock on
const foe = world.join('FOE');
foe.x = me.x + Math.sin(sess.cam.yaw) * 10;
foe.z = me.z + Math.cos(sess.cam.yaw) * 10;
press('\t');
check('Tab acquires the agent ahead', sess.lockId === foe.id);
step(45); // 1.5s locked, standing still
const bearing = Math.atan2(foe.x - me.x, foe.z - me.z);
let face = (bearing - me.yaw) % (Math.PI * 2);
if (face > Math.PI) face -= Math.PI * 2;
if (face < -Math.PI) face += Math.PI * 2;
check(`locked: player faces the target (off by ${Math.abs(face).toFixed(2)} rad)`, Math.abs(face) < 0.25);
press('\t');
check('Tab again releases the lock', sess.lockId === null);

// 3. roll: burst beats plain running over the same window
me.x = 2;
me.z = -20;
sess.speed = 0;
hold('w', 5);
const rx = me.x, rz = me.z;
press(' ');
step(12); // 0.4s — the roll window
const rolled = Math.hypot(me.x - rx, me.z - rz);
me.x = 2;
me.z = -20;
sess.speed = 0;
const bx = me.x, bz = me.z;
hold('w', 12); // the same 0.4s window, plain running
const ran = Math.hypot(me.x - bx, me.z - bz);
check(`a roll outruns plain running (${rolled.toFixed(1)}m vs ${ran.toFixed(1)}m baseline window)`, rolled > ran * 0.55);

sess.close();
if (failures) {
  console.error(`${failures} movement check(s) failed`);
  process.exit(1);
}
console.log('MOVEMENT OK');
process.exit(0);
