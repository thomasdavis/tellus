// Headless multiplayer check: two players in one world; does player 1's render
// see player 2 (and vice versa)?
import { RasterTarget, type Vec3 } from '@tellus/engine';
import { World } from '../src/world/world.js';
import { WorldRenderer } from '../src/render/renderer.js';

const world = new World();
const alice = world.join('ALICE');
const bravo = world.join('BRAVO');
// place them a few metres apart on flat ground, facing each other
alice.x = 0; alice.z = 0;
bravo.x = 0; bravo.z = 10;

const renderer = new WorldRenderer(world);
const target = new RasterTarget(200, 120);
const cols = 100, rows = 30;

// Alice's camera sits behind her (-Z), looking toward +Z where Bravo stands.
const eyeA: Vec3 = [0, world.groundAt(0, 0) + 3, -8];
const lookA: Vec3 = [0, world.groundAt(0, 0) + 1, 4];
const tagsA = renderer.render(target, world, alice.id, eyeA, lookA, cols, rows);

const names = tagsA.map((t) => `${t.name}${t.self ? '(you)' : ''}@${t.col},${t.row}`);
let pass = true;
const check = (label: string, cond: boolean, extra = ''): void => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}  ${extra}`);
  if (!cond) pass = false;
};

check('world has both players', world.population === 2, `population=${world.population}`);
check('agents() includes both players + creatures', world.agents().filter((a) => a.isPlayer).length === 2);
check("Alice's view produces a self nametag", tagsA.some((t) => t.self && t.name === 'ALICE'));
check("Alice SEES Bravo (other-player nametag rendered)", tagsA.some((t) => !t.self && t.name === 'BRAVO'), names.join(' '));

console.log(pass ? '\nMULTIPLAYER RENDER: PASS' : '\nMULTIPLAYER RENDER: FAIL');
process.exit(pass ? 0 : 1);
