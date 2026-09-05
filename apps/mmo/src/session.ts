// One SSH session = one player in the shared world. The session owns game input,
// the HUD and the simulation loop; the engine's ChaseCamera smooths the view and
// its TerminalPresenter turns framebuffers into minimal ANSI deltas. Rendering
// itself goes to the worker pool when one is available (inline as the fallback).
import type { Duplex } from 'node:stream';
import { RasterTarget, ChaseCamera, TerminalPresenter, type Vec3, ENTER_ALT, EXIT_ALT } from '@tellus/engine';
import type { World, Player } from './world/world.js';
import { COLOR_QUANT, type WorldRenderer, type NameTag } from './render/renderer.js';
import type { RenderPool } from './render/pool.js';

const SIM_HZ = 30;
const SIM_DT = 1 / SIM_HZ;
const RENDER_EVERY = 3; // ~10 fps — ambient motion doesn't need more, and it halves the terminal update load
const RUN_SPEED = 6.4; // m/s
const ACCEL = 9; // how quickly you reach full speed / glide to a stop
const TURN_RATE = 2.1; // rad/s camera orbit while an arrow is held
const FACE_RATE = 10; // how quickly the avatar turns to face travel
const FRESH_MS = 150; // a key counts as "held" this long after its last repeat
const MIN_COLS = 48;
const MIN_ROWS = 16;
// Use the terminal's real size so the world fills the screen — a bigger grid also
// means a higher-resolution octant framebuffer (2x4 sub-pixels per cell), i.e.
// crisper graphics. The cap is only a safety bound against a pathological window.
const MAX_COLS = 400;
const MAX_ROWS = 120;

function lerpAngle(a: number, b: number, t: number): number {
  const TAU = Math.PI * 2;
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export class MmoSession {
  private target!: RasterTarget;
  private readonly term: TerminalPresenter;
  private readonly cam = new ChaseCamera(); // starts looking north over the meadow
  private timer: NodeJS.Timeout | null = null;
  private inflight = false; // a frame is out at a render worker
  private tick = 0;
  private showHelp = false;
  private closed = false;

  // smoothed locomotion
  private speed = 0;
  private dirX = 0;
  private dirZ = 1;

  // key freshness (terminal auto-repeat keeps these fresh while held)
  private press = { w: 0, a: 0, s: 0, d: 0, left: 0, right: 0 };

  constructor(
    private stream: Duplex,
    private world: World,
    private renderer: WorldRenderer,
    private player: Player,
    cols: number,
    rows: number,
    private pool: RenderPool | null = null,
  ) {
    this.term = new TerminalPresenter(this.clampCols(cols), this.clampRows(rows), 'octant', COLOR_QUANT);
    this.allocateTarget();
  }

  private clampCols(cols: number): number {
    return Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
  }

  private clampRows(rows: number): number {
    return Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows));
  }

  private allocateTarget(): void {
    const [fbW, fbH] = this.term.fbSize();
    this.target = new RasterTarget(fbW, fbH);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(this.clampCols(cols), this.clampRows(rows));
    this.allocateTarget();
  }

  start(): void {
    this.stream.write(ENTER_ALT);
    let last = Date.now();
    let acc = 0;
    this.timer = setInterval(() => {
      const now = Date.now();
      acc += (now - last) / 1000;
      last = now;
      if (acc > 0.5) acc = 0.5;
      let steps = 0;
      while (acc >= SIM_DT && steps < 8) {
        this.stepOnce(now, SIM_DT);
        acc -= SIM_DT;
        steps++;
      }
    }, 1000 / SIM_HZ);
  }

  private stepOnce(now: number, dt: number): void {
    const held = (t: number): boolean => now - t < FRESH_MS;

    // --- smooth camera orbit (left turns left) ---
    const turn = (held(this.press.right) ? 1 : 0) - (held(this.press.left) ? 1 : 0);
    this.cam.turn(turn * TURN_RATE * dt);
    this.cam.easePitch(dt);

    // --- camera-relative move intent ---
    const f = (held(this.press.w) ? 1 : 0) - (held(this.press.s) ? 1 : 0);
    const r = (held(this.press.d) ? 1 : 0) - (held(this.press.a) ? 1 : 0);
    const moving = f !== 0 || r !== 0;
    if (moving) {
      const sin = Math.sin(this.cam.yaw);
      const cos = Math.cos(this.cam.yaw);
      const dx = sin * f + cos * r;
      const dz = cos * f - sin * r;
      const l = Math.hypot(dx, dz) || 1;
      this.dirX = dx / l;
      this.dirZ = dz / l;
    }

    // ease speed in and out so starts and stops glide
    this.speed += ((moving ? RUN_SPEED : 0) - this.speed) * Math.min(1, dt * ACCEL);

    const p = this.player;
    if (this.speed > 0.03) {
      this.world.step(p, this.dirX * this.speed * dt, this.dirZ * this.speed * dt);
      // turn the body smoothly toward the way we're travelling
      p.yaw = lerpAngle(p.yaw, Math.atan2(this.dirX, this.dirZ), Math.min(1, dt * FACE_RATE));
      p.moving = true;
    } else {
      p.moving = false;
    }

    this.tick++;
    if (this.tick % RENDER_EVERY === 0) this.renderFrame();
  }

  private renderFrame(): void {
    const p = this.player;
    const gy = this.world.groundAt(p.x, p.z);
    const { eye, look } = this.cam.frame(p.x, gy, p.z);

    // Off-thread render when a pool is available: hand the frame to a worker and
    // paint when it returns. One frame in flight at a time — if a worker is still
    // busy we skip this tick rather than pile up. Any failure falls back inline.
    if (this.pool && !this.inflight) {
      this.inflight = true;
      const tSec = (Date.now() - this.renderer.start) / 1000;
      const { cols, rows } = this.term;
      this.pool
        .render({ viewerId: p.id, eye, look, cols, rows, mode: this.term.renderMode, tSec, agents: this.world.snapshot() })
        .then((res) => {
          this.inflight = false;
          if (this.closed || res.cols !== this.term.cols || res.rows !== this.term.rows) return; // stale (resized mid-flight)
          this.term.adopt(res.ch, res.fg, res.bg);
          this.paint(res.tags);
        })
        .catch(() => {
          this.inflight = false;
          if (this.closed) return;
          this.renderInline(eye, look); // worker died/timed out — draw it here
        });
      return;
    }

    this.renderInline(eye, look);
  }

  /** Synchronous render on the main thread — the fallback when no pool is active. */
  private renderInline(eye: Vec3, look: Vec3): void {
    const tSec = (Date.now() - this.renderer.start) / 1000;
    const tags = this.renderer.render(this.target, this.world, this.player.id, eye, look, this.term.cols, this.term.rows, tSec);
    this.term.fit(this.target.rgb, this.target.width, this.target.height);
    this.paint(tags);
  }

  /** Overlay the HUD, diff against the previous frame, and write the minimal update. */
  private paint(tags: NameTag[]): void {
    this.drawHud(tags);
    const ansi = this.term.flush();
    if (ansi) {
      try {
        this.stream.write(ansi);
      } catch {
        /* client gone */
      }
    }
  }

  private drawHud(tags: NameTag[]): void {
    const s = this.term.screen;
    const W = this.term.cols;
    const rows = this.term.rows;
    const dim = 0x0c1a12;
    const cyan = 0x8fd0ff;
    const gold = 0xffd76a;
    const onScreen = new Set<number>();
    for (const t of tags) {
      onScreen.add(t.id);
      const label = t.self ? `△ ${t.name}` : `● ${t.name}`;
      const col = Math.max(0, Math.min(W - label.length, t.col - (label.length >> 1)));
      const row = Math.max(1, Math.min(rows - 2, t.row));
      s.text(col, row, label, t.self ? gold : cyan, dim);
    }
    // arrows to the players you can't currently see, so you can go find them
    this.drawFinders(onScreen);

    const p = this.player;
    const online = this.world.population;
    const l1 = ` TELLUS  ·  ${p.name}  ·  ${online} player${online === 1 ? '' : 's'} online `;
    s.text(0, 0, l1.padEnd(Math.min(W, l1.length + 1)), 0x9ff0c0, dim);
    const l2 = ` x ${p.x.toFixed(0)}  z ${p.z.toFixed(0)}  ${this.world.groundAt(p.x, p.z).toFixed(1)}m `;
    s.text(Math.max(0, W - l2.length), 0, l2, 0xbfeaff, dim);
    const hint = ' WASD run · ←/→ turn · ↑/↓ look · V view · ? help · Ctrl-C leave ';
    s.text(0, rows - 1, hint.slice(0, W).padEnd(Math.min(W, hint.length)), 0xbfeaff, dim);
    if (this.showHelp) this.drawHelp();
  }

  /** Edge arrows pointing toward every other player who is off-screen. */
  private drawFinders(onScreen: Set<number>): void {
    const s = this.term.screen;
    const dim = 0x0c1a12;
    const cyan = 0x8fd0ff;
    const eye = this.cam.eye ?? [0, 0, 0];
    const others = [...this.world.players.values()].filter((p) => p.id !== this.player.id && !onScreen.has(p.id));
    if (!others.length) return;
    const ranked = others
      .map((p) => {
        const dx = p.x - eye[0];
        const dz = p.z - eye[2];
        let rel = (Math.atan2(dx, dz) - this.cam.yaw) % (Math.PI * 2);
        if (rel > Math.PI) rel -= Math.PI * 2;
        if (rel < -Math.PI) rel += Math.PI * 2;
        return { p, rel, dist: Math.hypot(dx, dz) };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 4);
    let lrow = 2;
    let rrow = 2;
    for (const { p, rel, dist } of ranked) {
      const d = Math.round(dist);
      if (rel >= 0) {
        const label = `${p.name} ${d}m →`;
        s.text(Math.max(0, this.term.cols - label.length), Math.min(this.term.rows - 2, rrow++), label, cyan, dim);
      } else {
        const label = `← ${p.name} ${d}m`;
        s.text(0, Math.min(this.term.rows - 2, lrow++), label, cyan, dim);
      }
    }
  }

  private drawHelp(): void {
    const lines = [
      '  TELLUS — a small shared world ',
      '  ───────────────────────────────── ',
      '  You are a wanderer in a quiet meadow. ',
      '  Others you meet are real players, live. ',
      '  ',
      '  W A S D    run (relative to the camera) ',
      '  ← / →      turn the camera, smoothly ',
      '  ↑ / ↓      look up / down ',
      '  V          render mode: octant / half ',
      '  ?          close this help ',
      '  Ctrl-C     leave the world ',
      '  ───────────────────────────────── ',
      '  Every model here is from 3d.flobots.xyz, ',
      '  rendered live in your terminal. ',
      '  ',
      '  Press ? to close ',
    ];
    const s = this.term.screen;
    const bw = Math.min(this.term.cols - 2, 54);
    const top = Math.max(1, ((this.term.rows - lines.length) / 2) | 0);
    for (let i = 0; i < lines.length; i++) {
      s.text(1, top + i, lines[i]!.padEnd(bw).slice(0, bw), 0xffffff, 0x123021);
    }
  }

  onData(chunk: Buffer): void {
    const s = chunk.toString('latin1');
    const now = Date.now();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === '\x03') {
        this.close();
        return;
      }
      if (ch === '\x1b' && s[i + 1] === '[') {
        const code = s[i + 2];
        i += 2;
        if (code === 'A') this.cam.pitchTarget = Math.min(1.15, this.cam.pitchTarget + 0.09);
        else if (code === 'B') this.cam.pitchTarget = Math.max(-0.05, this.cam.pitchTarget - 0.09);
        else if (code === 'D') this.press.left = now; // left arrow → turn left
        else if (code === 'C') this.press.right = now; // right arrow → turn right
        continue;
      }
      const lc = ch.toLowerCase();
      if (lc === 'w') this.press.w = now;
      else if (lc === 'a') this.press.a = now;
      else if (lc === 's') this.press.s = now;
      else if (lc === 'd') this.press.d = now;
      else if (lc === 'v') {
        this.term.setMode(this.term.renderMode === 'octant' ? 'half' : 'octant');
        this.allocateTarget();
      } else if (ch === '?') {
        this.showHelp = !this.showHelp;
        this.term.invalidate();
      } else if (lc === 'q') {
        this.close();
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.world.leave(this.player.id);
    console.log(`- ${this.player.name} left (${this.world.population} online)`);
    try {
      this.stream.write(EXIT_ALT);
    } catch {
      /* */
    }
    try {
      (this.stream as unknown as { end: () => void }).end();
    } catch {
      /* */
    }
  }
}
