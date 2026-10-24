/**
 * The phone terminal's text size (BLG-108), as plain numbers so it can be tested. The grid is
 * always the Mac's (cols x rows); the phone only picks how big a cell is drawn. At a readable size
 * the Mac's columns are usually wider than the screen, so the page pans sideways (never resizing
 * the PTY or rewrapping). "Fit" draws the whole width at whatever size that takes.
 *
 * Kept between launches in kv under `TERM_FONT_KEY`: a size in px, or 'fit'.
 */

export const TERM_FONT_KEY = 'term-font';
/** Smallest and largest size a pinch or A-/A+ picks. */
export const FONT_MIN = 8;
export const FONT_MAX = 24;
/** Readable on a phone without zooming. */
export const FONT_DEFAULT = 13;
/** Fit to width may go below FONT_MIN (a 200-column Mac grid), but not to nothing. */
export const FIT_MIN = 4;
/** Line spacing on top of the font's own: none, JetBrains Mono's (1.32 em) is already roomy, and more would gap box drawing. */
export const LINE_HEIGHT = 1;
/** The page's padding around the grid, in px on each side. */
export const PAD = 6;

export type TermFont = number | 'fit';

/** A size in range, to the half pixel (sharper glyphs, fewer re-renders while pinching). */
export const clampFont = (size: number): number => {
  if (!Number.isFinite(size)) return FONT_DEFAULT;
  return Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, size)) * 2) / 2;
};

/** What kv holds, read safely (anything odd, or the old relative 'term-zoom', gives the default). */
export const readFont = (v: unknown): TermFont => (v === 'fit' ? 'fit' : typeof v === 'number' && Number.isFinite(v) ? clampFont(v) : FONT_DEFAULT);

/** A- / A+: one px a step, from where the text is now (the fitted size when fitting). */
export const stepFont = (now: number, dir: 1 | -1): number => clampFont(Math.round(now) + dir);

/**
 * The size that fits `cols` cells into `width` px, given a cell's width per px of font size
 * (`perPx`, measured in the page's font: about 0.6 for JetBrains Mono).
 */
export const fitFont = (width: number, cols: number, perPx: number): number => {
  const inner = Math.max(0, width - PAD * 2);
  const size = inner / (Math.max(1, cols) * (perPx > 0 ? perPx : 0.6));
  return Math.max(FIT_MIN, Math.min(FONT_MAX, Math.floor(size * 4) / 4));
};

