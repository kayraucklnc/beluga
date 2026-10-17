/**
 * Convert xterm buffer lines into klaud's styled `Line` model.
 *
 * Adjacent cells with identical style are merged into one `Seg`. Default
 * fg/bg map to `undefined` so the app theme shows through. Trailing blank,
 * unstyled cells are trimmed, so a line may be shorter than the terminal is
 * wide (the UI pads; `overlayCursor` pads when the cursor sits past the end).
 */
import type { IBufferCell, IBufferLine } from '@xterm/headless';
import { width, type Line, type Seg } from '../ui/text.js';
import { rgbToHex } from './palette.js';

const BOLD = 1;
const DIM = 2;
const ITALIC = 4;
const UNDERLINE = 8;
const INVERSE = 16;
const INVISIBLE = 32;

/** Colors: -1 = default, otherwise index into the 256 table, or 256 + packed rgb. */
const DEFAULT_COLOR = -1;
const RGB_BASE = 256;

const colorOf = (isDefault: boolean, isRgb: boolean, value: number): number =>
  isDefault ? DEFAULT_COLOR : isRgb ? RGB_BASE + value : value;

const flagsOf = (cell: IBufferCell): number =>
  (cell.isBold() ? BOLD : 0) |
  (cell.isDim() ? DIM : 0) |
  (cell.isItalic() ? ITALIC : 0) |
  (cell.isUnderline() ? UNDERLINE : 0) |
  (cell.isInverse() ? INVERSE : 0) |
  (cell.isInvisible() ? INVISIBLE : 0);

/** Width as Ink measures it, cached because string-width is not free. */
const widthCache = new Map<string, number>();
function inkWidth(chars: string): number {
  let w = widthCache.get(chars);
  if (w === undefined) {
    w = width(chars);
    if (widthCache.size > 4096) widthCache.clear();
    widthCache.set(chars, w);
  }
  return w;
}

/**
 * Make a cell's text occupy exactly `cells` columns as Ink measures it, so
 * a disagreement between xterm's and string-width's unicode tables can't
 * shift the rest of the row.
 */
function fitCell(chars: string, cells: number): string {
  if (chars === '') return cells === 2 ? '  ' : ' ';
  if (chars.length === 1 && chars.charCodeAt(0) < 0x7f) return cells === 1 ? chars : `${chars} `;
  const w = inkWidth(chars);
  if (w === cells) return chars;
  if (w === 0) return ' '.repeat(cells);
  if (w < cells) return chars + ' '.repeat(cells - w);
  return cells === 2 ? '� ' : '�';
}

export class LineRenderer {
  private readonly table: readonly string[];
  private readonly rgbCache = new Map<number, string>();

  constructor(colorTable: readonly string[]) {
    this.table = colorTable;
  }

  private hex(color: number): string | undefined {
    if (color === DEFAULT_COLOR) return undefined;
    if (color < RGB_BASE) return this.table[color];
    let hex = this.rgbCache.get(color);
    if (hex === undefined) {
      hex = rgbToHex(color - RGB_BASE);
      if (this.rgbCache.size > 4096) this.rgbCache.clear();
      this.rgbCache.set(color, hex);
    }
    return hex;
  }

  private seg(text: string, fg: number, bg: number, flags: number): Seg {
    const seg: { -readonly [K in keyof Seg]: Seg[K] } = { text: flags & INVISIBLE ? ' '.repeat(width(text)) : text };
    const color = this.hex(fg);
    const bgHex = this.hex(bg);
    if (color) seg.color = color;
    if (bgHex) seg.bg = bgHex;
    if (flags & BOLD) seg.bold = true;
    if (flags & DIM) seg.dim = true;
    if (flags & ITALIC) seg.italic = true;
    if (flags & UNDERLINE) seg.underline = true;
    if (flags & INVERSE) seg.inverse = true;
    return seg;
  }

  /** Render one buffer line (`cell` is a scratch cell reused across calls). */
  render(line: IBufferLine | undefined, cols: number, cell: IBufferCell): Line {
    if (!line) return [];
    const segs: Seg[] = [];
    let text = '';
    let fg = DEFAULT_COLOR;
    let bg = DEFAULT_COLOR;
    let flags = 0;
    // Column just after the last cell that must be kept (non-blank or styled).
    let keepTextLen = 0;
    let keepSegs = 0;
    const end = Math.min(cols, line.length);
    for (let x = 0; x < end; x++) {
      if (!line.getCell(x, cell)) break;
      const cells = cell.getWidth();
      if (cells === 0) continue; // trailing half of a wide char
      const cFg = colorOf(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor());
      const cBg = colorOf(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor());
      const cFlags = flagsOf(cell);
      if (text !== '' && (cFg !== fg || cBg !== bg || cFlags !== flags)) {
        segs.push(this.seg(text, fg, bg, flags));
        text = '';
      }
      fg = cFg;
      bg = cBg;
      flags = cFlags;
      const chars = cell.getChars();
      text += fitCell(chars, cells);
      const visible = (chars !== '' && chars !== ' ') || bg !== DEFAULT_COLOR || (flags & (INVERSE | UNDERLINE)) !== 0;
      if (visible) {
        keepSegs = segs.length;
        keepTextLen = text.length;
      }
    }
    if (keepTextLen === 0 && keepSegs === 0) return [];
    if (keepSegs < segs.length) {
      // The last kept cell lives in an already-flushed segment.
      const last = segs[keepSegs] as Seg;
      return [...segs.slice(0, keepSegs), { ...last, text: last.text.slice(0, keepTextLen) }];
    }
    if (keepTextLen > 0) segs.push(this.seg(text.slice(0, keepTextLen), fg, bg, flags));
    return segs;
  }
}

/** Draw a block cursor at column `x` as an inverse cell, padding if needed. */
export function overlayCursor(line: Line, x: number): Line {
  const out: Seg[] = [];
  let col = 0;
  let placed = false;
  for (const seg of line) {
    if (placed) {
      out.push(seg);
      continue;
    }
    const segWidth = width(seg.text);
    if (col + segWidth <= x) {
      out.push(seg);
      col += segWidth;
      continue;
    }
    let before = '';
    let rest = seg.text;
    for (const ch of seg.text) {
      const w = inkWidth(ch);
      if (col + w > x) break;
      before += ch;
      col += w;
      rest = rest.slice(ch.length);
    }
    const [first = ' '] = rest;
    const after = rest.slice(first.length);
    if (before) out.push({ ...seg, text: before });
    out.push({ ...seg, text: first, inverse: !seg.inverse });
    if (after) out.push({ ...seg, text: after });
    placed = true;
  }
  if (!placed) {
    if (x > col) out.push({ text: ' '.repeat(x - col) });
    out.push({ text: ' ', inverse: true });
  }
  return out;
}
