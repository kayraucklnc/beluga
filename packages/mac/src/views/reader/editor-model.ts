import type { Token } from '../../components/markdown/highlight.js';

/** The editor's small decisions (FileEditor.tsx), apart so they can be tested without a window. */

/**
 * Colored lines for the draft from tokens of a slightly older text: lines before and after the part
 * that changed keep their colors (by position from the start, and from the end); the rest are plain.
 */
export function alignTokens(draftLines: readonly string[], oldLines: readonly string[], tokens: ReadonlyArray<readonly Token[]> | undefined): Array<readonly Token[] | undefined> {
  const out: Array<readonly Token[] | undefined> = new Array(draftLines.length).fill(undefined);
  if (!tokens) return out;
  const max = Math.min(draftLines.length, oldLines.length);
  let head = 0;
  while (head < max && draftLines[head] === oldLines[head]) head++;
  let tail = 0;
  while (tail < max - head && draftLines[draftLines.length - 1 - tail] === oldLines[oldLines.length - 1 - tail]) tail++;
  for (let i = 0; i < head; i++) out[i] = tokens[i];
  for (let k = 1; k <= tail; k++) out[draftLines.length - k] = tokens[oldLines.length - k];
  return out;
}

/** What Tab puts in: the file's own indent (a tab, or two or four spaces). */
export function indentOf(text: string): string {
  if (/^\t/m.test(text)) return '\t';
  const four = /^ {4}\S/m.test(text) && !/^ {2}\S/m.test(text);
  return four ? '    ' : '  ';
}
