/**
 * What's a link in the agent's terminal (BLG-535), read from one line of its text: a visual's token
 * (`[[visual:7]]`, drawn over as a chip that opens it beside the terminal) and a task key the
 * board has (BLG-12, or task:BLG-12). Pure, on plain text: the terminal maps text back to its
 * cells (agent-term/term-links.ts).
 */

export interface VisualHit {
  readonly n: number;
  /** Where the token is in the text: [start, end). */
  readonly start: number;
  readonly end: number;
}

export interface TaskHit {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** Each visual token in a line. */
export function visualHits(text: string): VisualHit[] {
  const out: VisualHit[] = [];
  for (const m of text.matchAll(/\[\[visual:(\d{1,6})\]\]/g)) out.push({ n: Number(m[1]), start: m.index!, end: m.index! + m[0].length });
  return out;
}

/**
 * Each task key in a line the board has: "BLG-12" standing on its own (not part of a word, a path
 * or a URL), or "task:BLG-12" (the whole of it is the link).
 */
export function taskHits(text: string, has: (key: string) => boolean): TaskHit[] {
  if (!/[A-Z]-\d/.test(text)) return [];
  const out: TaskHit[] = [];
  for (const m of text.matchAll(/(^|[^\w/:@.#-])(task:)?([A-Z][A-Z0-9]{0,11}-\d{1,6})(?![\w/-]|\.\w)/g)) {
    const key = m[3]!;
    if (!has(key)) continue;
    const start = m.index! + m[1]!.length;
    out.push({ key, start, end: start + (m[2]?.length ?? 0) + key.length });
  }
  return out;
}

/**
 * How many cells a chip over a token may take: the token's own, and the blank cells after it on
 * the line (Claude writes the token on a line of its own), up to `want`.
 */
export function chipCells(text: string, hit: { readonly start: number; readonly end: number }, want: number, cols: number): number {
  let free = hit.end;
  while (free < text.length && text[free] === ' ') free++;
  // A line that ends right after the token (trailing blanks trimmed): the rest of the row is free.
  if (free >= text.length) free = Math.max(free, cols);
  const room = Math.min(free, cols) - hit.start;
  return Math.max(hit.end - hit.start, Math.min(want, room));
}
