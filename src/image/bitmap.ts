/**
 * A tiny RGBA pixel engine. Decoded images and game frames are both just Bitmaps:
 * draw into one, then hand it to `toLines` to get terminal lines.
 */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8Array;
}

export type Rgb = readonly [number, number, number];

export function createBitmap(width: number, height: number, fill: readonly [number, number, number, number] = [0, 0, 0, 0]): Bitmap {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const data = new Uint8Array(w * h * 4);
  if (fill.some((v) => v !== 0)) for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width: w, height: h, data };
}

/**
 * Area-average downsample (or nearest-neighbour upsample) to w×h. Averaging
 * every source pixel that falls in a target pixel keeps thin lines and text
 * readable instead of shimmering like plain point sampling. Colors are
 * alpha-weighted so transparent edges don't turn dark.
 */
export function resize(src: Bitmap, width: number, height: number): Bitmap {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (w === src.width && h === src.height) return src;
  const out = new Uint8Array(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  const s = src.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const al = s[i + 3]!;
          r += s[i]! * al;
          g += s[i + 1]! * al;
          b += s[i + 2]! * al;
          a += al;
        }
      }
      const o = (y * w + x) * 4;
      const n = (x1 - x0) * (y1 - y0);
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** Largest pixel size that fits `cols`×`rows` cells, keeping the aspect ratio (1 cell = 1×2 pixels). */
export function fitPixels(src: { width: number; height: number }, cols: number, rows: number, upscale = false): { width: number; height: number } {
  const maxW = Math.max(1, cols);
  const maxH = Math.max(2, rows * 2);
  let scale = Math.min(maxW / src.width, maxH / src.height);
  if (!upscale) scale = Math.min(1, scale);
  return { width: Math.max(1, Math.round(src.width * scale)), height: Math.max(1, Math.round(src.height * scale)) };
}

/** Composite pixel (x, y) over `bg`. */
export function pixelOver(bmp: Bitmap, x: number, y: number, bg: Rgb): Rgb {
  if (y >= bmp.height || x >= bmp.width) return bg;
  const i = (y * bmp.width + x) * 4;
  const d = bmp.data;
  const r = d[i]!;
  const g = d[i + 1]!;
  const b = d[i + 2]!;
  const a = d[i + 3]! / 255;
  if (a >= 1) return [r, g, b];
  return [Math.round(r * a + bg[0] * (1 - a)), Math.round(g * a + bg[1] * (1 - a)), Math.round(b * a + bg[2] * (1 - a))];
}
