import stringWidth from 'string-width';

/** One visual row of the composer: `buffer.slice(start, end)` (never includes the newline). */
export interface Row {
  readonly start: number;
  readonly end: number;
}

/** Columns a single code point takes (ASCII fast path; typing must stay instant on long drafts). */
const charWidth = (ch: string): number => {
  const c = ch.charCodeAt(0);
  return c >= 0x20 && c < 0x7f ? 1 : stringWidth(ch);
};

/** Is the UTF-16 unit at `i` the second half of a surrogate pair? */
const isLowSurrogate = (s: string, i: number): boolean => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** UTF-16 length of the whole character before / after `at`, so emoji move and delete as one. */
export const charBefore = (s: string, at: number): number => (at >= 2 && isLowSurrogate(s, at - 1) ? 2 : 1);
export const charAfter = (s: string, at: number): number => (isLowSurrogate(s, at + 1) ? 2 : 1);

/**
 * Columns the draft wraps at: the box minus borders, padding and the "❯ " prompt, minus the
 * right-hand controls (and a gap), minus one column so the cursor always fits at a row's end.
 */
export const composerWrapWidth = (columns: number, rightWidth: number): number => Math.max(4, columns - 6 - (rightWidth ? rightWidth + 1 : 0) - 1);

function wrapUncached(buffer: string, width: number): Row[] {
  const w = Math.max(2, width);
  const rows: Row[] = [];
  let p = 0;
  for (;;) {
    const nl = buffer.indexOf('\n', p);
    const pEnd = nl === -1 ? buffer.length : nl;
    let rowStart = p;
    let col = 0;
    let lastBreak = -1;
    for (let i = p; i < pEnd; ) {
      const step = charAfter(buffer, i);
      const ch = buffer.slice(i, i + step);
      const cw = charWidth(ch);
      if (col + cw > w && i > rowStart) {
        // Break after the last space on this row (word-aware), or mid-word if there is none.
        const cut = lastBreak > rowStart ? lastBreak : i;
        rows.push({ start: rowStart, end: cut });
        rowStart = cut;
        col = 0;
        for (let j = cut; j < i; j += charAfter(buffer, j)) col += charWidth(buffer.slice(j, j + charAfter(buffer, j)));
        lastBreak = -1;
      }
      col += cw;
      i += step;
      if (ch === ' ') lastBreak = i;
    }
    rows.push({ start: rowStart, end: pEnd });
    if (nl === -1) return rows;
    p = nl + 1;
  }
}

let memo: { buffer: string; width: number; rows: Row[] } | undefined;

/**
 * Wrap the draft into visual rows `width` columns wide: at spaces where possible, and at
 * every newline. Memoised (render, layout and the keymap all ask for the same wrap).
 */
export function wrapBuffer(buffer: string, width: number): readonly Row[] {
  if (memo && memo.buffer === buffer && memo.width === width) return memo.rows;
  const rows = wrapUncached(buffer, width);
  memo = { buffer, width, rows };
  return rows;
}

/** The row the cursor is on (at a soft wrap it belongs to the next row, like most editors). */
export function rowOf(rows: readonly Row[], cursor: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid]!.start <= cursor) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Display column of `at` inside `row`. */
export const columnOf = (buffer: string, row: Row, at: number): number => stringWidth(buffer.slice(row.start, Math.min(at, row.end)));

/** The offset in `row` closest to display column `col` (for ↑↓ between rows). */
export function offsetAt(buffer: string, row: Row, col: number): number {
  let x = 0;
  let i = row.start;
  while (i < row.end) {
    const step = charAfter(buffer, i);
    const cw = charWidth(buffer.slice(i, i + step));
    if (x + cw > col) break;
    x += cw;
    i += step;
  }
  // A soft-wrapped row's end is the next row's start: stop just before it so ↓ lands on this row.
  return i;
}

/** Word characters (letters, digits, underscore); anything else separates words, like macOS. */
const WORD = /[\p{L}\p{N}_]/u;
const isWord = (s: string, i: number): boolean => WORD.test(s[i] ?? '');

/** Start of the word before `at` (Option+←, Option+Backspace). */
export function wordLeft(s: string, at: number): number {
  let i = at;
  while (i > 0 && !isWord(s, i - 1)) i--;
  while (i > 0 && isWord(s, i - 1)) i--;
  return i;
}

/** End of the word after `at` (Option+→, Option+Delete). */
export function wordRight(s: string, at: number): number {
  let i = at;
  while (i < s.length && !isWord(s, i)) i++;
  while (i < s.length && isWord(s, i)) i++;
  return i;
}

/** Normalise pasted or fast-typed text for the draft: real newlines, no tabs or control codes. */
export const cleanText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');

// ---- accelerating delete ("inertia")

/** A run of auto-repeated Backspace events. */
export interface RepeatState {
  readonly start: number;
  readonly last: number;
}

/** Repeats further apart than this are separate presses (macOS auto-repeat is ~30-90 ms apart). */
export const REPEAT_GAP_MS = 120;
/** Hold this long before deletes speed up. */
export const RAMP_AFTER_MS = 600;
/** Events stamped the same (the input layer stamps each stdin chunk) are a backlog, and count once. */
const SAME_CHUNK_MS = 1;

export type DeleteStep = { readonly kind: 'chars'; readonly n: number } | { readonly kind: 'word' };

/**
 * How much one Backspace event deletes: one character, then (after holding for a while)
 * 2, 4, and finally whole words. A backlog of repeats in one chunk counts once while
 * accelerated, so letting go never leaves extra deletions queued up.
 */
export function repeatStep(prev: RepeatState | undefined, now: number): { state: RepeatState; step: DeleteStep } {
  const continuing = prev !== undefined && now - prev.last >= 0 && now - prev.last < REPEAT_GAP_MS;
  const state: RepeatState = { start: continuing ? prev.start : now, last: now };
  const held = now - state.start;
  if (!continuing || held < RAMP_AFTER_MS) return { state, step: { kind: 'chars', n: 1 } };
  if (now - prev.last < SAME_CHUNK_MS) return { state: { ...state, last: prev.last }, step: { kind: 'chars', n: 0 } };
  if (held < RAMP_AFTER_MS * 2) return { state, step: { kind: 'chars', n: 2 } };
  if (held < RAMP_AFTER_MS * 3) return { state, step: { kind: 'chars', n: 4 } };
  return { state, step: { kind: 'word' } };
}
