import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/shared/diff-lines.js';

describe('parseDiff', () => {
  it('numbers old and new lines and skips file headers', () => {
    const rows = parseDiff(['diff --git a/x b/x', 'index 1..2', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@ fn', ' a', '-b', '+c', ''].join('\n'));
    expect(rows).toEqual([
      { kind: 'hunk', text: 'Lines 1–2 · fn' },
      { kind: 'ctx', text: 'a', old: 1, new: 1 },
      { kind: 'del', text: 'b', old: 2 },
      { kind: 'add', text: 'c', new: 2 },
    ]);
  });

  it('keeps changed lines that look like file headers', () => {
    // Deleting "-- comment" (SQL) and adding "++ x" give "--- comment" and "+++ x" inside the hunk.
    const rows = parseDiff(['--- a/q.sql', '+++ b/q.sql', '@@ -3,2 +3,2 @@', '--- comment', '+++ x', ' select 1;'].join('\n'));
    expect(rows.map((r) => [r.kind, r.text, r.old, r.new])).toEqual([
      ['hunk', 'Lines 3–4', undefined, undefined],
      ['del', '-- comment', 3, undefined],
      ['add', '++ x', undefined, 3],
      ['ctx', 'select 1;', 4, 4],
    ]);
  });

  it('reads several files and hunks, and notes', () => {
    const rows = parseDiff(['diff --git a/n b/n', 'new file mode 100644', '--- /dev/null', '+++ b/n', '@@ -0,0 +1 @@', '+hi', '\\ No newline at end of file', 'diff --git a/o b/o', 'deleted file mode 100644', '--- a/o', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye'].join('\n'));
    expect(rows.map((r) => r.kind)).toEqual(['meta', 'hunk', 'add', 'meta', 'meta', 'hunk', 'del']);
    expect(rows[1]!.text).toBe('Line 1');
    expect(rows[5]!.text).toBe('Removed');
  });
});
