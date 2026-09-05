// Terminal presenter: packed RGB framebuffer -> truecolour cells -> minimal ANSI delta.
//  octant mode: each cell is a 2x4 sub-pixel block (Unicode 16 octants) -> a (2*cols) x (4*rows)
//               framebuffer, 8 real sub-pixels per cell, fg/bg split by brightness. Crispest.
//  half mode:   each cell renders U+2580 ('▀') over a (cols) x (2*rows) framebuffer. 2 sub-pixels
//               per cell, exact colours, works on ANY terminal (no Unicode-16 dependency).
// HUD text overrides cells in either mode.
import { OCTANT_CHARS } from './octant-chars.js';

const UPPER_HALF = 0x2580;
const SPACE = 0x20;
const OCTANT_CP: number[] = OCTANT_CHARS.map((s) => s.codePointAt(0)!);

export type RenderMode = 'octant' | 'half';
/** Sub-pixel framebuffer size for a cols x rows cell grid in the given mode. */
export function fbSize(mode: RenderMode, cols: number, rows: number): [number, number] {
  return mode === 'octant' ? [cols * 2, rows * 4] : [cols, rows * 2];
}

export class Screen {
  readonly ch: Uint32Array;
  readonly fg: Int32Array;  // packed 0xRRGGBB, -1 = default
  readonly bg: Int32Array;
  constructor(public cols: number, public rows: number) {
    const n = cols * rows;
    this.ch = new Uint32Array(n);
    this.fg = new Int32Array(n);
    this.bg = new Int32Array(n);
    this.ch.fill(SPACE);
    this.fg.fill(-1);
    this.bg.fill(-1);
  }

  /** Fill the grid from a sub-pixel framebuffer. Colours are quantized to `step`
   *  levels so sub-threshold wave shimmer does not flip cells every frame — this is
   *  what keeps the ocean's delta bandwidth bounded. */
  setFromFramebuffer(rgb: Uint8Array, fbW: number, fbH: number, mode: RenderMode, step = 16): void {
    if (mode === 'octant') this.fitOctant(rgb, fbW, fbH, step);
    else this.fitHalf(rgb, fbW, fbH, step);
  }

  private fitHalf(rgb: Uint8Array, fbW: number, fbH: number, step: number): void {
    const { cols, rows, ch, fg, bg } = this;
    const half = step >> 1, mask = ~(step - 1);
    const q = (v: number): number => { const x = (v + half) & mask; return x > 255 ? 255 : x; };
    for (let r = 0; r < rows; r++) {
      const topY = r * 2, botY = r * 2 + 1;
      for (let c = 0; c < cols; c++) {
        const cell = r * cols + c;
        const tx = c < fbW ? c : fbW - 1;
        const to = (topY * fbW + tx) * 3;
        const bo = ((botY < fbH ? botY : fbH - 1) * fbW + tx) * 3;
        ch[cell] = UPPER_HALF;
        fg[cell] = (q(rgb[to]) << 16) | (q(rgb[to + 1]) << 8) | q(rgb[to + 2]);
        bg[cell] = (q(rgb[bo]) << 16) | (q(rgb[bo + 1]) << 8) | q(rgb[bo + 2]);
      }
    }
  }

  // 2x4 octant fit: split the block's 8 sub-pixels into bright (fg) / dark (bg) groups
  // by mid-brightness threshold, pick the octant glyph for that bit pattern.
  private fitOctant(rgb: Uint8Array, fbW: number, fbH: number, step: number): void {
    const { cols, rows, ch, fg, bg } = this;
    const half = step >> 1, mask = ~(step - 1);
    const q = (v: number): number => { const x = (v + half) & mask; return x > 255 ? 255 : x; };
    const R = new Int32Array(8), G = new Int32Array(8), B = new Int32Array(8), Lum = new Int32Array(8);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let mn = 1e9, mx = -1e9;
        for (let dy = 0; dy < 4; dy++) {
          const py = r * 4 + dy; const yy = (py < fbH ? py : fbH - 1) * fbW;
          for (let dx = 0; dx < 2; dx++) {
            const px = c * 2 + dx; const xx = px < fbW ? px : fbW - 1;
            const o = (yy + xx) * 3; const i = dy * 2 + dx;
            const rr = rgb[o], gg = rgb[o + 1], bb = rgb[o + 2];
            R[i] = rr; G[i] = gg; B[i] = bb;
            const l = (rr * 77 + gg * 150 + bb * 29) >> 8; Lum[i] = l;
            if (l < mn) mn = l; if (l > mx) mx = l;
          }
        }
        const cell = r * cols + c;
        if (mx - mn <= 8) {                                   // ~uniform -> solid cell
          let sr = 0, sg = 0, sb = 0; for (let i = 0; i < 8; i++) { sr += R[i]; sg += G[i]; sb += B[i]; }
          const col = (q(sr >> 3) << 16) | (q(sg >> 3) << 8) | q(sb >> 3);
          ch[cell] = OCTANT_CP[0xff]; fg[cell] = col; bg[cell] = col; continue;
        }
        const thr = (mn + mx) >> 1;
        let pat = 0, fr = 0, fgc = 0, fb = 0, fn = 0, br = 0, bgc = 0, bb2 = 0, bn = 0;
        for (let i = 0; i < 8; i++) {
          if (Lum[i] >= thr) { pat |= 1 << i; fr += R[i]; fgc += G[i]; fb += B[i]; fn++; }
          else { br += R[i]; bgc += G[i]; bb2 += B[i]; bn++; }
        }
        ch[cell] = OCTANT_CP[pat];
        fg[cell] = fn ? (q((fr / fn) | 0) << 16) | (q((fgc / fn) | 0) << 8) | q((fb / fn) | 0) : 0;
        bg[cell] = bn ? (q((br / bn) | 0) << 16) | (q((bgc / bn) | 0) << 8) | q((bb2 / bn) | 0) : 0;
      }
    }
  }

  /** Draw text over the image (HUD). fgCol/bgCol packed 0xRRGGBB; bgCol<0 keeps underlying. */
  text(col: number, row: number, str: string, fgCol: number, bgCol = -1): void {
    if (row < 0 || row >= this.rows) return;
    for (let i = 0; i < str.length; i++) {
      const c = col + i;
      if (c < 0 || c >= this.cols) continue;
      const cell = row * this.cols + c;
      this.ch[cell] = str.codePointAt(i)!;
      this.fg[cell] = fgCol;
      if (bgCol >= 0) this.bg[cell] = bgCol;
    }
  }
}

const cup = (row: number, col: number): string => `\x1b[${row + 1};${col + 1}H`;
const sgrFg = (c: number): string => `\x1b[38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`;
const sgrBg = (c: number): string => `\x1b[48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m`;

/** Diff `cur` against `prev` (same dims) and return the minimal ANSI to update the terminal.
 *  If `keyframe`, emit every cell. Mutates `prev` to match `cur`. */
export function diffToAnsi(cur: Screen, prev: Screen, keyframe: boolean): string {
  const { cols, rows } = cur;
  let out = '';
  let curRow = -1, curCol = -1;
  let lastFg = -2, lastBg = -2;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      if (!keyframe && cur.ch[i] === prev.ch[i] && cur.fg[i] === prev.fg[i] && cur.bg[i] === prev.bg[i]) {
        continue;
      }
      if (curRow !== r || curCol !== c) {
        out += cup(r, c);
        curRow = r; curCol = c;
      }
      if (cur.fg[i] !== lastFg) { out += sgrFg(cur.fg[i] < 0 ? 0xffffff : cur.fg[i]); lastFg = cur.fg[i]; }
      if (cur.bg[i] !== lastBg) { out += sgrBg(cur.bg[i] < 0 ? 0 : cur.bg[i]); lastBg = cur.bg[i]; }
      out += String.fromCodePoint(cur.ch[i]);
      curCol = c + 1;
      prev.ch[i] = cur.ch[i]; prev.fg[i] = cur.fg[i]; prev.bg[i] = cur.bg[i];
    }
  }
  return out;
}

export const ENTER_ALT = '\x1b[?1049h\x1b[?25l\x1b[2J';   // alt screen, hide cursor, clear
export const EXIT_ALT = '\x1b[?25h\x1b[0m\x1b[?1049l';    // show cursor, reset, leave alt screen
export const HOME_RESET = '\x1b[H\x1b[0m';
