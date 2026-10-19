import type { Line, Seg } from '../shared/text.js';
import { type Bitmap, type Rgb, fitPixels, pixelOver, resize } from './bitmap.js';

/**
 * `blocks`: truecolor half blocks, two square pixels per cell (best for photos and games).
 * `ascii`: a brightness ramp of plain characters, tinted with the pixel color.
 */
export type RenderMode = 'blocks' | 'ascii';

export interface RenderOptions {
  readonly mode?: RenderMode;
  /** Color behind transparent pixels (default: the terminal's background shows through). */
  readonly background?: Rgb;
  /** Grow small images (pixel art, game frames) to fill the space. */
  readonly upscale?: boolean;
}

const RAMP = ' .:-=+*#%@';
const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hex = (c: Rgb): string => `#${HEX[c[0]]!}${HEX[c[1]]!}${HEX[c[2]]!}`;

/** Append, merging with the previous segment when the style is identical (far fewer escape codes). */
function push(line: Seg[], text: string, color: string, bg?: string): void {
  const last = line.at(-1);
  if (last && (last.color ?? '') === color && last.bg === bg) line[line.length - 1] = { ...last, text: last.text + text };
  else line.push({ text, ...(color ? { color } : {}), ...(bg ? { bg } : {}) });
}

const luma = (c: Rgb): number => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Darkest and brightest visible pixel, so text art uses the whole ramp even for dim images. */
function lumaRange(bmp: Bitmap): [number, number] {
  let lo = 1;
  let hi = 0;
  const d = bmp.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 128) continue;
    const l = luma([d[i]!, d[i + 1]!, d[i + 2]!]);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  return lo > hi ? [0, 1] : [lo, hi];
}

/** Pixel (x, y) as a color, or undefined where it's (mostly) transparent and no background was given. */
function colorAt(bmp: Bitmap, x: number, y: number, bg: Rgb | undefined): Rgb | undefined {
  if (y >= bmp.height) return bg;
  if (bg) return pixelOver(bmp, x, y, bg);
  const i = (y * bmp.width + x) * 4;
  return bmp.data[i + 3]! < 128 ? undefined : [bmp.data[i]!, bmp.data[i + 1]!, bmp.data[i + 2]!];
}

/**
 * Render a bitmap that is already the right pixel size (w ≤ cols, h ≤ 2·rows). Fast path for game loops.
 * Without a `background`, transparent pixels show the terminal's own background.
 */
export function bitmapToLines(bmp: Bitmap, opts: RenderOptions = {}): Line[] {
  const bg = opts.background;
  const lines: Line[] = [];
  const [lo, hi] = opts.mode === 'ascii' ? lumaRange(bmp) : [0, 1];
  const span = Math.max(1e-3, hi - lo);
  for (let y = 0; y < bmp.height; y += 2) {
    const line: Seg[] = [];
    for (let x = 0; x < bmp.width; x++) {
      const top = colorAt(bmp, x, y, bg);
      const bottom = colorAt(bmp, x, y + 1, bg);
      if (opts.mode === 'ascii') {
        const c = top && bottom ? ([(top[0] + bottom[0]) >> 1, (top[1] + bottom[1]) >> 1, (top[2] + bottom[2]) >> 1] as const) : (top ?? bottom);
        if (!c) push(line, ' ', '');
        else push(line, RAMP.charAt(Math.min(RAMP.length - 1, Math.floor(((luma(c) - lo) / span) * RAMP.length))), hex(c));
      } else if (top && bottom) push(line, '▀', hex(top), hex(bottom));
      else if (top) push(line, '▀', hex(top));
      else if (bottom) push(line, '▄', hex(bottom));
      else push(line, ' ', '');
    }
    lines.push(line);
  }
  return lines;
}

/** Fit any bitmap into cols×rows cells (aspect kept, area-averaged) and render it. */
export function imageToLines(bmp: Bitmap, cols: number, rows: number, opts: RenderOptions = {}): Line[] {
  if (bmp.width === 0 || bmp.height === 0 || cols <= 0 || rows <= 0) return [];
  const size = fitPixels(bmp, cols, rows, opts.upscale);
  return bitmapToLines(resize(bmp, size.width, size.height), opts);
}
