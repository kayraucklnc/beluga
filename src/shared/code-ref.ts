/**
 * A piece of the repository Claude points at in chat, as a fenced block:
 *
 *   ```beluga-code
 *   src/core/workbench.ts:120-140
 *   highlight: 128-130, 134
 *   ```
 *
 * The chat draws those lines from the worktree, the highlighted ones marked, with a way to open
 * them in the editor. Browser-safe: no Node.
 */

export const CODE_FENCE = 'beluga-code';

export interface CodeRef {
  readonly path: string;
  /** First and last line shown (1-based); missing: the top of the file. */
  readonly from?: number;
  readonly to?: number;
  /** Lines to mark. */
  readonly highlight: readonly number[];
  /** A line about it, shown above. */
  readonly note?: string;
}

/** The most lines one block shows. */
export const MAX_REF_LINES = 400;

/** "12-18, 22" → [12…18, 22] (at most MAX_REF_LINES). */
export function parseLineList(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b) && out.length < MAX_REF_LINES; n++) if (n > 0) out.push(n);
  }
  return out;
}

/** "src/a.ts:12-40" (or "src/a.ts#L12-L40", or a bare path) → where. */
export function parseLocation(text: string): Pick<CodeRef, 'path' | 'from' | 'to'> | undefined {
  const m = /^\s*`?([^\s`:#]+)`?(?:(?::|#L)(\d+)(?:-L?(\d+))?)?\s*$/.exec(text);
  if (!m) return undefined;
  const from = m[2] ? Number(m[2]) : undefined;
  const to = m[3] ? Number(m[3]) : from;
  if (from && to && to < from) return { path: m[1]!, from: to, to: from };
  return { path: m[1]!, ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/** A beluga-code fence's text → the reference (undefined when its first line isn't a path). */
export function parseCodeRef(code: string): CodeRef | undefined {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  const where = lines[0] ? parseLocation(lines[0]) : undefined;
  if (!where) return undefined;
  let highlight: number[] = [];
  let note: string | undefined;
  for (const line of lines.slice(1)) {
    const m = /^(highlight|hl|note)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    if (m[1]!.toLowerCase() === 'note') note = m[2]!.trim() || undefined;
    else highlight = parseLineList(m[2]!);
  }
  return { ...where, highlight, ...(note ? { note } : {}) };
}

/** The window of lines to read: the range asked for, else a little around what's highlighted, else the top. */
export function refWindow(ref: CodeRef, context = 3): { from: number; to: number } {
  const lo = ref.highlight.length ? Math.min(...ref.highlight) : undefined;
  const hi = ref.highlight.length ? Math.max(...ref.highlight) : undefined;
  const from = ref.from ?? (lo ? Math.max(1, lo - context) : 1);
  const to = ref.to ?? (hi ? hi + context : from + 29);
  return { from, to: Math.min(to, from + MAX_REF_LINES - 1) };
}

/** A unified diff hunk ("@@ -10,6 +12,8 @@ …") as rows with each side's line number. */
export interface HunkRow {
  readonly kind: 'add' | 'del' | 'ctx';
  readonly text: string;
  readonly old?: number;
  readonly new?: number;
}

export function parseHunk(hunk: string): HunkRow[] {
  const rows: HunkRow[] = [];
  let oldN = 0;
  let newN = 0;
  for (const line of hunk.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      oldN = Number(head[1]);
      newN = Number(head[2]);
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), new: newN++ });
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), old: oldN++ });
    else rows.push({ kind: 'ctx', text: line.slice(1), old: oldN++, new: newN++ });
  }
  return rows;
}

/** The language shiki knows a file by, from its extension. */
export function langOf(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = { ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', go: 'go', rs: 'rust', css: 'css', html: 'html', md: 'md', yml: 'yaml', yaml: 'yaml', sql: 'sql', swift: 'swift', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', rb: 'ruby', toml: 'toml' };
  return map[ext];
}
