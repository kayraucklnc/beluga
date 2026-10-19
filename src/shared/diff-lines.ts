// Unified diffs (git diff) as rows to draw, for any screen.

/** One row of a diff: a change, context, a hunk heading, or a note (new file, no newline…). */
export type DiffLine = { kind: 'ctx' | 'add' | 'del' | 'hunk' | 'meta'; text: string; old?: number; new?: number };

/** A unified diff, line by line, with old and new line numbers. */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  // Lines left in the current hunk: inside one, "--- x" is a deleted "-- x", not a file header.
  let oldLeft = 0;
  let newLeft = 0;
  const rows = diff.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  for (const raw of rows) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    const h = inHunk ? null : /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (h) {
      o = Number(h[1]);
      n = Number(h[3]);
      oldLeft = Number(h[2] ?? 1);
      newLeft = Number(h[4] ?? 1);
      const where = h[5]?.trim();
      const range = newLeft === 0 ? `Removed${n ? ` after line ${n}` : ''}` : newLeft === 1 ? `Line ${n}` : `Lines ${n}–${n + newLeft - 1}`;
      out.push({ kind: 'hunk', text: `${range}${where ? ` · ${where}` : ''}` });
    } else if (inHunk && raw.startsWith('+')) {
      newLeft--;
      out.push({ kind: 'add', text: raw.slice(1), new: n++ });
    } else if (inHunk && raw.startsWith('-')) {
      oldLeft--;
      out.push({ kind: 'del', text: raw.slice(1), old: o++ });
    } else if (raw.startsWith('\\')) out.push({ kind: 'meta', text: raw.slice(2) });
    else if (inHunk) {
      oldLeft--;
      newLeft--;
      out.push({ kind: 'ctx', text: raw.slice(1), old: o++, new: n++ });
    } else if (raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('rename ')) out.push({ kind: 'meta', text: raw });
    // Other file headers (diff --git, index, ---, +++, modes) say nothing the list doesn't.
  }
  return out;
}
