/**
 * "[image N]" in the message box is one thing, not words: Backspace or Delete takes it out
 * whole (and its picture with it), and the arrow keys step over it. (Pure: use-attachments.tsx
 * applies it to the box.)
 *
 * In the box it also carries the end of the image's file name, "[image 1 · 142525-fpxw]" (no
 * breaking spaces, so it never wraps), which the box draws as a chip; it goes out as "[image 1]".
 */

/** "[image 1]", or "[image 1 · name]" in the box. */
export const IMAGE_REF = /\[image[  ](\d+)(?: · ([^\]\n]{1,24}))?\]/g;

/** How much of a file name a chip shows: its end, without the extension. */
const TAIL = 10;

/** The end of a file name, for its chip ("20261024-142525-fpxw.png" → "42525-fpxw"). */
export const nameTail = (file: string): string => {
  const base = (file.split('/').pop() ?? file).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\]\n]/g, '').trim();
  return base.length > TAIL ? base.slice(-TAIL) : base;
};

/** The reference to image `n` in the box: with the end of its name when it has one. */
export const boxRef = (n: number, name?: string): string => {
  const tail = name ? nameTail(name) : '';
  return tail ? `[image ${n} · ${tail}]` : `[image ${n}]`;
};

interface Ref {
  readonly n: number;
  readonly start: number;
  readonly end: number;
  /** The end of its file name, when it shows one. */
  readonly name?: string;
}

export const imageRefsIn = (text: string): Ref[] =>
  [...text.matchAll(IMAGE_REF)].map((m) => ({ n: Number(m[1]), start: m.index, end: m.index + m[0].length, ...(m[2] ? { name: m[2] } : {}) }));

/** The numbers of the images referenced in `text`. */
export const referencedImages = (text: string): number[] => imageRefsIn(text).map((r) => r.n);

/** The words as they go out: every reference back to a plain "[image N]". */
export const plainRefs = (text: string): string => text.replace(IMAGE_REF, (_, n: string) => `[image ${n}]`);

/** `text` without its reference to image `n` (and the space before it). */
export const withoutRef = (text: string, n: number): string => {
  const r = imageRefsIn(text).find((x) => x.n === n);
  if (!r) return text;
  const start = r.start > 0 && text[r.start - 1] === ' ' ? r.start - 1 : r.start;
  return text.slice(0, start) + text.slice(r.end);
};

export type RefKey = 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight';

export type RefEdit =
  /** Take `start`–`end` out of the words; `images` lose their reference. */
  | { readonly kind: 'delete'; readonly start: number; readonly end: number; readonly images: readonly number[] }
  | { readonly kind: 'move'; readonly cursor: number };

/**
 * What a key does to the box when it touches a reference (undefined: what it always does).
 * `start`/`end`: the selection.
 */
export function refKey(text: string, start: number, end: number, key: RefKey): RefEdit | undefined {
  const refs = imageRefsIn(text);
  if (!refs.length) return undefined;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (start !== end) return undefined;
    const r = refs.find((x) => (key === 'ArrowLeft' ? x.start < start && start <= x.end : x.start <= start && start < x.end));
    return r ? { kind: 'move', cursor: key === 'ArrowLeft' ? r.start : r.end } : undefined;
  }
  if (start !== end) {
    // A selection that cuts into a reference takes all of it.
    const touched = refs.filter((r) => r.start < end && start < r.end);
    if (!touched.length) return undefined;
    return { kind: 'delete', start: Math.min(start, ...touched.map((r) => r.start)), end: Math.max(end, ...touched.map((r) => r.end)), images: touched.map((r) => r.n) };
  }
  const r = refs.find((x) => (key === 'Backspace' ? x.start < start && start <= x.end : x.start <= start && start < x.end));
  if (!r) return undefined;
  // One space goes with it, so "see [image 1] here" becomes "see here".
  const spaceAfter = text[r.end] === ' ' && (r.start === 0 || text[r.start - 1] === ' ');
  return { kind: 'delete', start: r.start, end: r.end + (spaceAfter ? 1 : 0), images: [r.n] };
}
