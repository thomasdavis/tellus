// One player session: owns boat state, runs fixed-step sim + throttled render, parses keys.
import type { Duplex } from 'stream';
import { RasterTarget } from '@tellus/engine';
import { Screen, diffToAnsi, fbSize, RenderMode, ENTER_ALT, EXIT_ALT } from '@tellus/engine';
import { SceneRenderer, loadBoat, BoatAsset, Buoy } from '../scene/index.js';
import { BoatState, Wind, newBoat, stepBoat, applyCommand, Command } from '../sailing/index.js';

const SIM_HZ = 30;
const SIM_DT = 1 / SIM_HZ;
const RENDER_EVERY = 2;         // render every 2nd sim tick -> 15 Hz
const KN = 1.943844;            // m/s -> knots
const MIN_COLS = 40, MIN_ROWS = 12;

const BOAT: BoatAsset = loadBoat();
const COURSE: Buoy[] = [
  { x: 6, z: 46, color: [235, 120, 30] },
  { x: 34, z: 78, color: [230, 40, 40] },
  { x: -26, z: 74, color: [240, 210, 40] },
];

const DEG = (r: number) => ((r * 180 / Math.PI) % 360 + 360) % 360;
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
function windArrow(vx: number, vz: number): string {
  // direction the air moves, mapped to 8-way arrow (screen: +Z up, +X right)
  const a = Math.atan2(vx, vz);           // 0 = +Z (up)
  const i = (Math.round(a / (Math.PI / 4)) + 8) % 8;
  return ARROWS[i];
}

export class SailingSession {
  private boat: BoatState;
  private wind: Wind = { dirFrom: Math.PI / 2, speed: 8.5 };
  private scene: SceneRenderer;
  private target!: RasterTarget;
  private cur!: Screen;
  private prev!: Screen;
  private t = 0;
  private tick = 0;
  private timer: NodeJS.Timeout | null = null;
  private keyframe = true;
  private queued: Command[] = [];
  private showHelp = false;
  private fov = 1.05;
  private mode: RenderMode = 'octant';
  private camYaw = 0;           // camera orbit offsets (arrow keys)
  private camPitch = 0.1;

  constructor(private stream: Duplex, private cols: number, private rows: number) {
    this.boat = newBoat(0, 0, 0);
    this.scene = new SceneRenderer(BOAT, COURSE);
    this.allocate(cols, rows);
  }

  private allocate(cols: number, rows: number): void {
    this.cols = Math.max(MIN_COLS, cols);
    this.rows = Math.max(MIN_ROWS, rows);
    const [fbW, fbH] = fbSize(this.mode, this.cols, this.rows);
    this.target = new RasterTarget(fbW, fbH);
    this.cur = new Screen(this.cols, this.rows);
    this.prev = new Screen(this.cols, this.rows);
    this.keyframe = true;
  }

  start(): void {
    this.stream.write(ENTER_ALT);
    let last = Date.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      acc += (now - last) / 1000;
      last = now;
      if (acc > 0.5) acc = 0.5;                 // avoid spiral of death
      let steps = 0;
      while (acc >= SIM_DT && steps < 8) {
        this.stepOnce();
        acc -= SIM_DT;
        steps++;
      }
    }, 1000 / SIM_HZ);
  }

  private stepOnce(): void {
    for (const c of this.queued) applyCommand(this.boat, c);
    this.queued.length = 0;
    stepBoat(this.boat, this.wind, this.t, SIM_DT);
    this.t += SIM_DT;
    this.tick++;
    if (this.tick % RENDER_EVERY === 0) this.renderFrame();
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.allocate(cols, rows);
  }

  private renderFrame(): void {
    // Native octant resolution is crispest; supersampling would only get re-quantized
    // to 2 colours/cell by the octant fit, so we render 1:1.
    this.scene.render(this.target, this.boat, this.wind, this.t, SIM_DT * RENDER_EVERY, this.fov, 1, this.camYaw, this.camPitch);
    this.cur.setFromFramebuffer(this.target.rgb, this.target.width, this.target.height, this.mode, 16);
    this.drawHud();
    const ansi = diffToAnsi(this.cur, this.prev, this.keyframe);
    this.keyframe = false;
    if (ansi) this.stream.write(ansi);
  }

  private drawHud(): void {
    const s = this.boat, W = this.cols;
    const white = 0xffffff, dim = 0x0a1a26, cyan = 0x7fe0f0, amber = 0xffd24a, green = 0x8ff0a0;
    const spd = (s.speed * KN).toFixed(1);
    const hdg = DEG(s.yaw).toFixed(0).padStart(3, '0');
    const [twx, twz] = trueWind(this.wind);
    const line1 = ` HDG ${hdg}°  SPD ${spd}kn  WIND ${(this.wind.speed * KN).toFixed(0)}kn ${windArrow(twx, twz)} `;
    const rud = (s.rudder * 45).toFixed(0);
    const line2 = ` TRIM ${(s.trim * 100).toFixed(0)}%  RUD ${rud.startsWith('-') ? rud : '+' + rud}°  VMG ${(s.vmg * KN).toFixed(1)}kn  EFF ${(s.sailEff * 100).toFixed(0)}% `;
    this.cur.text(0, 0, line1.padEnd(Math.min(W, line1.length + 1)), cyan, dim);
    this.cur.text(0, 1, line2.padEnd(Math.min(W, line2.length + 1)), amber, dim);
    if (s.autoTrim) this.cur.text(Math.min(W - 10, line2.length + 1), 1, ' AUTO ', green, dim);

    const hint = ' W/S trim  A/D rudder  Arrows cam  Space auto-trim  R recover  ? help  Ctrl-C quit ';
    this.cur.text(0, this.rows - 1, hint.slice(0, W), 0xbfeaff, dim);

    if (this.showHelp) this.drawHelp();
  }

  private drawHelp(): void {
    const lines = [
      '  SSH SAILING ',
      '  ───────────────────────────── ',
      '  You are sailing a small sloop. The wind is fixed; ',
      '  trim your sail and steer to build speed. ',
      '  ',
      '  W          trim sail IN (haul) ',
      '  S          ease sail OUT ',
      '  A          rudder to port ',
      '  D          rudder to starboard ',
      '  X          centre the rudder ',
      '  Space      toggle auto-trim ',
      '  Arrows     orbit the camera (look around) ',
      '  V          render mode: octant / half-block ',
      '  R          recover if stuck ',
      '  ?          close this help ',
      '  ───────────────────────────── ',
      '  Sail across the wind (beam reach) to go fastest. ',
      '  Point too close to the wind and you stall. ',
      '  ',
      '  Press ? to close ',
    ];
    const bw = Math.min(this.cols - 2, 52);
    const top = Math.max(1, ((this.rows - lines.length) / 2) | 0);
    for (let i = 0; i < lines.length; i++) {
      this.cur.text(1, top + i, lines[i].padEnd(bw).slice(0, bw), 0xffffff, 0x10202e);
    }
  }

  onData(chunk: Buffer): void {
    const s = chunk.toString('latin1');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\x03') { this.close(); return; }           // Ctrl-C
      if (ch === '\x1b' && s[i + 1] === '[') {                // arrow keys -> orbit camera
        const code = s[i + 2]; i += 2;
        if (code === 'A') this.camPitch = Math.min(1.3, this.camPitch + 0.1);        // up: lift / look down
        else if (code === 'B') this.camPitch = Math.max(-0.3, this.camPitch - 0.1);  // down
        else if (code === 'D') this.camYaw += 0.14;                                   // left: orbit
        else if (code === 'C') this.camYaw -= 0.14;                                   // right: orbit
        continue;
      }
      const lc = ch.toLowerCase();
      if (lc === 'w') this.queued.push('trim-in');
      else if (lc === 's') this.queued.push('trim-out');
      else if (lc === 'a') this.queued.push('rudder-left');
      else if (lc === 'd') this.queued.push('rudder-right');
      else if (lc === 'x') this.queued.push('rudder-center');
      else if (ch === ' ') this.queued.push('auto-trim');
      else if (lc === 'r') this.queued.push('recover');
      else if (lc === 'v') { this.mode = this.mode === 'octant' ? 'half' : 'octant'; this.allocate(this.cols, this.rows); }
      else if (ch === '?') { this.showHelp = !this.showHelp; this.keyframe = true; }
      else if (lc === 'q') { this.close(); return; }
    }
  }

  close(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.stream.write(EXIT_ALT); } catch { /* */ }
    try { (this.stream as unknown as { end: () => void }).end(); } catch { /* */ }
  }
}

function trueWind(w: Wind): [number, number] {
  return [-Math.sin(w.dirFrom) * w.speed, -Math.cos(w.dirFrom) * w.speed];
}
