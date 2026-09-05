// TerminalPresenter: the full "framebuffer → terminal" lifecycle in one object.
// Owns the current + previous cell grids, the render mode, colour quantization
// and keyframe bookkeeping, so a game session just fits a framebuffer (or adopts
// cells rendered elsewhere), draws its HUD, and flushes the minimal ANSI delta.
import { Screen, diffToAnsi, fbSize, type RenderMode } from './index.js';

export class TerminalPresenter {
  cols: number;
  rows: number;
  /** The working grid for this frame — draw HUD text onto it via `.text(...)`. */
  screen!: Screen;
  private prev!: Screen;
  private keyframe = true;

  constructor(
    cols: number,
    rows: number,
    private mode: RenderMode = 'octant',
    private readonly quant = 16,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.allocate();
  }

  private allocate(): void {
    this.screen = new Screen(this.cols, this.rows);
    this.prev = new Screen(this.cols, this.rows);
    this.keyframe = true;
  }

  /** Sub-pixel framebuffer dimensions for the current grid + mode. */
  fbSize(): [number, number] {
    return fbSize(this.mode, this.cols, this.rows);
  }

  get renderMode(): RenderMode {
    return this.mode;
  }

  /** Switch octant/half rendering; the next flush repaints everything. */
  setMode(mode: RenderMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.allocate();
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.allocate();
  }

  /** Force the next flush to emit every cell (e.g. after an overlay closes). */
  invalidate(): void {
    this.keyframe = true;
  }

  /** Fill the grid from a packed-RGB sub-pixel framebuffer. */
  fit(rgb: Uint8Array, fbW: number, fbH: number): void {
    this.screen.setFromFramebuffer(rgb, fbW, fbH, this.mode, this.quant);
  }

  /** Adopt cell buffers rendered elsewhere (a worker thread) — must match dims. */
  adopt(ch: Uint32Array, fg: Int32Array, bg: Int32Array): void {
    this.screen.ch.set(ch);
    this.screen.fg.set(fg);
    this.screen.bg.set(bg);
  }

  /** Diff against the previously flushed frame → minimal ANSI update string. */
  flush(): string {
    const out = diffToAnsi(this.screen, this.prev, this.keyframe);
    this.keyframe = false;
    return out;
  }
}
