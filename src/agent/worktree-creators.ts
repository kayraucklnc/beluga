import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { claudeConfigDir, pathVariants, sessionTitle } from './claude-sessions.js';

/**
 * Which Claude Code conversation made a worktree: the one whose Bash call ran
 * `git worktree add <that folder>`. Read-only; it looks through ~/.claude/projects.
 */

export interface WorktreeCreator {
  readonly sessionId: string;
  readonly title?: string;
  /** Where that conversation ran. */
  readonly cwd?: string;
  /** When it made the worktree. */
  readonly at?: number;
}

const SEPARATORS = /\s*(?:&&|\|\||;|\n|\|)\s*/;
/** `git worktree add` options that take a value. */
const VALUE_FLAGS = new Set(['-b', '-B', '--reason']);
const NEEDLE = 'worktree add';

/** Split one shell command into words (quotes respected; nothing expanded). */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

const resolveFrom = (base: string, p: string): string | undefined => {
  const expanded = p.replace(/^~(?=$|\/)/, os.homedir());
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return base ? path.resolve(base, expanded) : undefined;
};

/**
 * The folders a shell command makes worktrees in, resolved against where it ran (following
 * `cd X &&` and `git -C X`). Paths built from variables are skipped.
 */
export function worktreeAddTargets(command: string, cwd: string): string[] {
  const out: string[] = [];
  let here = cwd;
  for (const segment of command.split(SEPARATORS)) {
    const w = words(segment);
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift(); // FOO=bar git …
    if (w[0] === 'cd' && w[1]) {
      here = resolveFrom(here, w[1]) ?? here;
      continue;
    }
    if (w[0] !== 'git') continue;
    let i = 1;
    let base = here;
    while (w[i]?.startsWith('-')) {
      if (w[i] === '-C' && w[i + 1]) base = resolveFrom(base, w[i + 1]!) ?? base;
      i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
    }
    if (w[i] !== 'worktree' || w[i + 1] !== 'add') continue;
    i += 2;
    while (i < w.length && w[i]!.startsWith('-')) i += VALUE_FLAGS.has(w[i]!) ? 2 : 1;
    const target = w[i];
    if (!target || /[$`]/.test(target)) continue;
    const resolved = resolveFrom(base, target);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** Every transcript file under `dir` (sessions and their sub-agents) changed since `since`. */
async function transcriptFiles(dir: string, since: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const st = await stat(full).catch(() => undefined);
        if (st && st.mtimeMs >= since) out.push(full);
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Transcript files that mention `git worktree add` at all (a byte search, before parsing anything). */
async function filesMentioningWorktreeAdd(projectsDir: string, since: number): Promise<string[]> {
  const needle = Buffer.from(NEEDLE);
  const hits: string[] = [];
  for (const file of await transcriptFiles(projectsDir, since)) {
    const bytes = await readFile(file).catch(() => undefined);
    if (bytes && bytes.indexOf(needle) >= 0) hits.push(file);
  }
  return hits;
}

type Entry = { type?: string; cwd?: string; sessionId?: string; timestamp?: string; message?: { content?: unknown } };

async function scanFile(file: string, wanted: Map<string, string>, found: Map<string, WorktreeCreator>): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes(NEEDLE)) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content as Array<{ type?: string; input?: { command?: unknown } }>) {
      if (block.type !== 'tool_use' || typeof block.input?.command !== 'string') continue;
      for (const target of worktreeAddTargets(block.input.command, entry.cwd ?? '')) {
        for (const variant of pathVariants(target)) {
          const key = wanted.get(variant);
          if (!key) continue;
          const at = entry.timestamp ? Date.parse(entry.timestamp) : undefined;
          const prev = found.get(key);
          const sessionId = entry.sessionId ?? path.basename(file, '.jsonl');
          // The earliest one made it (later ones may have re-added it after a removal).
          if (!prev || (at !== undefined && (prev.at === undefined || at < prev.at))) found.set(key, { sessionId, ...(entry.cwd ? { cwd: entry.cwd } : {}), ...(at !== undefined ? { at } : {}) });
        }
      }
    }
  }
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { creator?: WorktreeCreator; at: number }>();

/**
 * For each folder, the Claude Code conversation that made it (if one did), with its title.
 * `since`: skip transcripts last written before then (the oldest of those folders' birth).
 * Results are remembered for a few minutes.
 */
export async function findCreators(paths: readonly string[], opts: { projectsDir?: string; since?: number; fresh?: boolean } = {}): Promise<Map<string, WorktreeCreator>> {
  const now = Date.now();
  const result = new Map<string, WorktreeCreator>();
  const todo = paths.filter((p) => {
    const hit = opts.fresh ? undefined : cache.get(p);
    if (hit && now - hit.at < CACHE_MS) {
      if (hit.creator) result.set(p, hit.creator);
      return false;
    }
    return true;
  });
  if (!todo.length) return result;
  const wanted = new Map<string, string>();
  for (const p of todo) for (const v of pathVariants(p)) wanted.set(v, p);
  const found = new Map<string, WorktreeCreator>();
  // A conversation that made a worktree was still being written to when it did.
  const files = await filesMentioningWorktreeAdd(opts.projectsDir ?? path.join(claudeConfigDir(), 'projects'), opts.since ?? 0);
  for (const file of files) await scanFile(file, wanted, found).catch(() => undefined);
  const titles = new Map<string, string>();
  for (const id of new Set([...found.values()].map((c) => c.sessionId))) {
    const info = await getSessionInfo(id).catch(() => undefined);
    if (info) titles.set(id, sessionTitle(info));
  }
  for (const p of todo) {
    const c = found.get(p);
    const creator = c ? { ...c, ...(titles.has(c.sessionId) ? { title: titles.get(c.sessionId)! } : {}) } : undefined;
    cache.set(p, { ...(creator ? { creator } : {}), at: now });
    if (creator) result.set(p, creator);
  }
  return result;
}
