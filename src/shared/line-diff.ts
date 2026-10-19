import type { DiffLine } from './diff-lines.js';

/**
 * An edit Claude made (old text → new text) as diff rows, so a screen can draw it like any
 * other diff. Line-based (longest common subsequence), with a few lines of context around
 * each change. Browser-safe.
 */

/** Past this many lines on either side, the diff is "everything removed, everything added". */
const MAX_LINES = 1500;
const CONTEXT = 3;

type Op = { kind: 'ctx' | 'add' | 'del'; text: string };

function ops(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length > MAX_LINES || b.length > MAX_LINES) return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  // Common start and end first: most edits change a few lines in the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  const n = x.length;
  const m = y.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const middle: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      middle.push({ kind: 'ctx', text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) middle.push({ kind: 'del', text: x[i++]! });
    else middle.push({ kind: 'add', text: y[j++]! });
  }
  while (i < n) middle.push({ kind: 'del', text: x[i++]! });
  while (j < m) middle.push({ kind: 'add', text: y[j++]! });
  return [...a.slice(0, start).map((text) => ({ kind: 'ctx' as const, text })), ...middle, ...a.slice(a.length - end).map((text) => ({ kind: 'ctx' as const, text }))];
}

const linesOf = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/**
 * Diff rows for one edit. Line numbers count from 1 within the edited text (Claude's edit
 * tools don't say where in the file it is). Unchanged stretches longer than the context are
 * folded into a hunk line.
 */
export function editDiff(oldText: string, newText: string): DiffLine[] {
  const all = ops(linesOf(oldText), linesOf(newText));
  const keep = all.map(() => false);
  all.forEach((op, k) => {
    if (op.kind === 'ctx') return;
    for (let d = Math.max(0, k - CONTEXT); d <= Math.min(all.length - 1, k + CONTEXT); d++) keep[d] = true;
  });
  const out: DiffLine[] = [];
  let o = 1;
  let n = 1;
  let skipped = false;
  all.forEach((op, k) => {
    if (!keep[k]) {
      skipped = true;
      o++;
      n++;
      return;
    }
    if (skipped && out.length) out.push({ kind: 'hunk', text: '⋯' });
    skipped = false;
    if (op.kind === 'ctx') out.push({ kind: 'ctx', text: op.text, old: o++, new: n++ });
    else if (op.kind === 'del') out.push({ kind: 'del', text: op.text, old: o++ });
    else out.push({ kind: 'add', text: op.text, new: n++ });
  });
  return out;
}

/** A new file's content as added lines. */
export const addedLines = (text: string): DiffLine[] => linesOf(text).map((line, i) => ({ kind: 'add' as const, text: line, new: i + 1 }));
