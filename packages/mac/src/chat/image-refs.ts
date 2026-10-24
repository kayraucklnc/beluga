/**
 * "[image N]" in the message box is one thing, not words: Backspace or Delete takes it out
 * whole (and its picture with it), and the arrow keys step over it. (Pure: use-attachments.tsx
 * applies it to the box.)
 */

const REF = /\[image (\d+)\]/g;

interface Ref {
  readonly n: number;
  readonly start: number;
  readonly end: number;
}

export const imageRefsIn = (text: string): Ref[] => [...text.matchAll(REF)].map((m) => ({ n: Number(m[1]), start: m.index, end: m.index + m[0].length }));

/** The numbers of the images referenced in `text`. */
export const referencedImages = (text: string): number[] => imageRefsIn(text).map((r) => r.n);

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
