import path from 'node:path';

/**
 * What an agent made or looked at while it worked, from its transcript: the screenshots it took,
 * the logs and test output it wrote and read back, the JSON it fetched. Not its work (code it
 * edited is in the worktree's Changes): what it produced along the way. Wherever it put them:
 * its scratch folder, /tmp, test-results/… Pure: no files (watch.ts looks at what's still there).
 */

/** wrote: a file tool saved it · read: it looked at it · ran: a command wrote it (or named it). */
export type OutputHow = 'wrote' | 'read' | 'ran';

export interface OutputRef {
  /** A full path. */
  readonly path: string;
  readonly how: OutputHow;
  /** When it was last mentioned. */
  readonly ts: number;
}

export type OutputKind = 'image' | 'pdf' | 'video' | 'json' | 'markdown' | 'text' | 'file';

/** Outputs remembered per transcript (the oldest go first). */
export const MAX_OUTPUTS = 100;
/** Paths taken from one tool's result (a listing of a folder of pictures isn't all outputs). */
export const MAX_RESULT_PATHS = 20;
/** Results longer than this are only looked through this far. */
const TEXT_SCAN = 200_000;

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MEDIA = /\.(png|jpe?g|gif|webp|pdf|mp4|m4v|webm|mov)$/i;
const TRACE = /[\\/][^\\/]*trace[^\\/]*\.zip$/i;
const TEXT = /\.(log|txt|out|json|jsonl|ndjson|md|markdown|csv|tsv|xml|html?)$/i;
/** Inside the project, text is source unless it's in a folder outputs go to. */
const OUTPUT_DIRS = /[\\/](\.(?:beluga|klaud)[\\/]scratch|test-results|playwright-report|coverage|\.context|screenshots|tmp)[\\/]/;
const NEVER = /[\\/](node_modules|\.git)[\\/]/;

const isMedia = (p: string): boolean => MEDIA.test(p) || TRACE.test(p);
const inside = (root: string, p: string): boolean => p === root || p.startsWith(`${root}/`);

export function outputKind(p: string): OutputKind {
  if (IMAGE.test(p)) return 'image';
  if (/\.pdf$/i.test(p)) return 'pdf';
  if (/\.(mp4|m4v|webm|mov)$/i.test(p)) return 'video';
  if (/\.(json|jsonl|ndjson)$/i.test(p)) return 'json';
  if (/\.(md|markdown)$/i.test(p)) return 'markdown';
  if (TEXT.test(p)) return 'text';
  return 'file';
}

/** Something an agent made (not source): pictures anywhere, text outside the project or where outputs go. */
export function isArtifact(p: string, cwd?: string): boolean {
  if (!path.isAbsolute(p) || NEVER.test(p)) return false;
  if (isMedia(p)) return true;
  if (!TEXT.test(p)) return false;
  // Only the folders inside the project count: a project that itself sits in a tmp/ (or coverage/…) folder isn't all output.
  return !cwd || !inside(cwd, p) || OUTPUT_DIRS.test(p.slice(cwd.length));
}

/** Where a command's output was sent (a redirect, tee, -o): any picture or text file. */
const isTarget = (p: string): boolean => path.isAbsolute(p) && !p.startsWith('/dev/') && !NEVER.test(p) && (isMedia(p) || TEXT.test(p));

const full = (p: string, cwd?: string): string | undefined => {
  const raw = p.replace(/^~(?=\/)/, process.env.HOME ?? '~');
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return cwd ? path.resolve(cwd, raw) : undefined;
};

/** A command's words, quotes taken off (good enough to find file names; never run). */
function words(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

const REDIRECT = /^(?:\d|&)?>>?(.*)$/;
const OUT_FLAG = /^(?:-o|--out|--output|--outfile|--output-file|--outputFile|--screenshot|--path)(?:=(.+))?$/;
const PIPE_END = /^(?:\||\|\||&&|;)$/;

/** Files a shell command writes (redirects, tee, -o/--output) or names (pictures, traces). */
function commandPaths(command: string, cwd?: string): string[] {
  const w = words(command.slice(0, 20_000));
  const found: string[] = [];
  const take = (raw: string | undefined, check: (p: string) => boolean): void => {
    if (!raw || raw.startsWith('&') || raw.includes('://')) return;
    const p = full(raw, cwd);
    if (p && check(p)) found.push(p);
  };
  let tee = false;
  for (let i = 0; i < w.length; i++) {
    const word = w[i]!;
    if (PIPE_END.test(word)) {
      tee = false;
      continue;
    }
    const redirect = REDIRECT.exec(word);
    if (redirect) {
      take(redirect[1] || w[++i], isTarget);
      continue;
    }
    const flag = OUT_FLAG.exec(word);
    if (flag) {
      take(flag[1] ?? w[++i], isTarget);
      continue;
    }
    if (word === 'tee') {
      tee = true;
      continue;
    }
    if (tee && !word.startsWith('-')) take(word, isTarget);
    else if (!word.startsWith('-')) take(word, (p) => isMedia(p) && !NEVER.test(p));
  }
  return found;
}

/** The text files a command sends its output to (`> app.log`, `| tee run.txt`, `-o out.json`). */
export const commandLogs = (command: string, cwd?: string): string[] => commandPaths(command, cwd).filter((p) => TEXT.test(p));

const FILE_TOOLS: Readonly<Record<string, OutputHow>> = { Write: 'wrote', Edit: 'wrote', MultiEdit: 'wrote', NotebookEdit: 'wrote', Read: 'read' };
/** Where other tools (browsers, MCP servers) say they save a file. */
const SAVE_KEYS = ['filename', 'filePath', 'file_path', 'outputPath', 'output_path', 'savePath', 'save_path', 'screenshotPath', 'outFile'];

/** The outputs one tool call made or looked at. */
export function refsOfTool(name: string, input: Readonly<Record<string, unknown>>, cwd: string | undefined, ts: number): OutputRef[] {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const refs = (paths: readonly (string | undefined)[], how: OutputHow): OutputRef[] =>
    [...new Set(paths.filter((p): p is string => p !== undefined))].map((p) => ({ path: p, how, ts }));
  const fileHow = FILE_TOOLS[name];
  if (fileHow) {
    const p = full(str(input.file_path) ?? str(input.notebook_path) ?? '', cwd);
    return refs([p && isArtifact(p, cwd) ? p : undefined], fileHow);
  }
  if (name === 'Bash') return refs(commandPaths(str(input.command) ?? '', cwd), 'ran');
  if (!name.startsWith('mcp__')) return [];
  return refs(
    SAVE_KEYS.map((k) => {
      const v = str(input[k]);
      const p = v ? full(v, cwd) : undefined;
      return p && isArtifact(p, cwd) ? p : undefined;
    }),
    'wrote',
  );
}

const QUOTED = /["'`](\/[^"'`\n]{1,1000}?)["'`]/g;
const BARE = /(?:^|[\s(=:,])(\/[^\s"'`<>()]{1,1000})/g;

/** Full paths of pictures, PDFs, videos and traces a tool's result mentions, in order. */
export function pathsInText(text: string): string[] {
  const t = text.slice(0, TEXT_SCAN);
  const hits: Array<{ at: number; p: string }> = [];
  for (const m of t.matchAll(QUOTED)) hits.push({ at: m.index, p: m[1]! });
  // Not the path of a URL (https://host/x.png).
  for (const m of t.matchAll(BARE)) if (!m[1]!.startsWith('//')) hits.push({ at: m.index, p: m[1]!.replace(/[.,;:)\]]+$/, '') });
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.at - b.at)
    .map((h) => path.normalize(h.p))
    .filter((p) => isMedia(p) && !NEVER.test(p) && !seen.has(p) && Boolean(seen.add(p)))
    .slice(0, MAX_RESULT_PATHS);
}

/** The outputs one transcript mentions, newest mention first and bounded. */
export class OutputLog {
  private readonly refs = new Map<string, OutputRef>();

  add(refs: readonly OutputRef[]): void {
    for (const r of refs) {
      const old = this.refs.get(r.path);
      if (old && old.ts > r.ts) continue;
      this.refs.delete(r.path);
      // Reading back what it made (a screenshot it took) doesn't make it something it only looked at.
      this.refs.set(r.path, old && old.how !== 'read' && r.how === 'read' ? { ...r, how: old.how } : r);
    }
    if (this.refs.size > MAX_OUTPUTS) for (const old of this.list().slice(MAX_OUTPUTS)) this.refs.delete(old.path);
  }

  list(): OutputRef[] {
    return [...this.refs.values()].reverse().sort((a, b) => b.ts - a.ts);
  }
}
