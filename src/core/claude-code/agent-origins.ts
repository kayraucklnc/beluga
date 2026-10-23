import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentOrigin } from './model.js';
import { finishedIn, readMeta } from './agents.js';
import { headLines } from './tail.js';
import { parseLine } from './transcript.js';

/**
 * Where a sub-agent's worktree came from, read from Claude Code's own files: each session keeps
 * its sub-agents' side files (`<session>/subagents/agent-<id>.meta.json`), so a worktree under
 * `.claude/worktrees/agent-<id>` leads back to the conversation that started it, its folder and
 * title, long after Beluga stopped following it. Reads only.
 */

const SESSION_DIR = /^[0-9a-f-]{8,64}$/i;
const META_FILE = /^agent-([\w-]+)\.meta\.json$/;
const AGENT_DIR = /[\\/]\.claude[\\/]worktrees[\\/]agent-([\w-]+)\/?$/;
/** How long before an agent it couldn’t find is looked for again (a look is a few ms, even with years of sessions). */
const RETRY_MS = 10_000;
const TITLE_TAIL = 256 * 1024;

const list = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

const mtime = async (file: string): Promise<number> => {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
};

/** The end of a file (titles are written as a session goes on). */
function tailLines(file: string, max: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    return len < size ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join(' ');
  return text || undefined;
};

const oneLine = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
};

/** A session's folder and what it's called: your title, else Claude Code's, else your first message. */
export function sessionFacts(file: string): { cwd?: string; title?: string } {
  let cwd: string | undefined;
  let first: string | undefined;
  for (const line of headLines(file, 64 * 1024)) {
    const e = parseLine(line) as { cwd?: string; type?: string; isMeta?: boolean; message?: { content?: unknown } } | undefined;
    if (!e) continue;
    cwd ??= typeof e.cwd === 'string' ? e.cwd : undefined;
    if (first === undefined && e.type === 'user' && !e.isMeta) {
      const text = textOf(e.message?.content)?.trim();
      if (text && !text.startsWith('<')) first = oneLine(text);
    }
    if (cwd && first) break;
  }
  let custom: string | undefined;
  let ai: string | undefined;
  for (const line of tailLines(file, TITLE_TAIL)) {
    if (!line.includes('-title"')) continue;
    const e = parseLine(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown } | undefined;
    if (e?.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) custom = oneLine(e.customTitle);
    if (e?.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) ai = oneLine(e.aiTitle);
  }
  const title = custom ?? ai ?? first;
  return { ...(cwd ? { cwd } : {}), ...(title ? { title } : {}) };
}

interface Located {
  readonly metaFile: string;
  readonly sessionFile: string;
  readonly sessionId: string;
}

export class AgentOrigins {
  private index = new Map<string, Located>();
  private indexedAt = -Infinity;
  /** By worktree, with the side file's time when read (a change reads it again). */
  private readonly cache = new Map<string, { readonly origin: AgentOrigin; readonly at: number }>();

  constructor(
    private readonly home: string,
    private readonly opts: { readonly retryMs?: number; readonly now?: () => number } = {},
  ) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Every sub-agent side file Claude Code kept, by agent id. */
  private async reindex(): Promise<void> {
    const index = new Map<string, Located>();
    const projects = path.join(this.home, 'projects');
    for (const folder of await list(projects)) {
      const dir = path.join(projects, folder);
      for (const sessionId of await list(dir)) {
        if (!SESSION_DIR.test(sessionId)) continue;
        const agents = path.join(dir, sessionId, 'subagents');
        for (const name of await list(agents)) {
          const id = META_FILE.exec(name)?.[1];
          if (id) index.set(id, { metaFile: path.join(agents, name), sessionFile: path.join(dir, `${sessionId}.jsonl`), sessionId });
        }
      }
    }
    this.index = index;
    this.indexedAt = this.now;
  }

  private async originOf(worktree: string, agentId: string, at: Located): Promise<AgentOrigin> {
    const meta = readMeta(at.metaFile);
    const finished = finishedIn(at.metaFile);
    const session = sessionFacts(at.sessionFile);
    const lastAt = Math.max(await mtime(at.metaFile), await mtime(at.metaFile.replace(/\.meta\.json$/, '.jsonl')));
    return {
      path: worktree,
      agentId,
      sessionId: at.sessionId,
      lastAt,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.agentType ? { type: meta.agentType } : {}),
      ...(meta.worktreeBranch ? { branch: meta.worktreeBranch } : {}),
      ...(session.cwd ? { sessionCwd: session.cwd } : {}),
      ...(session.title ? { sessionTitle: session.title } : {}),
      ...(finished ? { finished: true as const } : {}),
    };
  }

  /** The origins of these sub-agent worktrees (those Claude Code still has a record of). Not called again before it resolves. */
  async find(worktrees: readonly string[]): Promise<AgentOrigin[]> {
    const out: AgentOrigin[] = [];
    for (const wt of worktrees) {
      const agentId = AGENT_DIR.exec(wt)?.[1];
      if (!agentId) continue;
      if (!this.index.has(agentId) && this.now - this.indexedAt >= (this.opts.retryMs ?? RETRY_MS)) await this.reindex();
      const at = this.index.get(agentId);
      if (!at) continue;
      const stamp = await mtime(at.metaFile);
      const known = this.cache.get(wt);
      if (known && known.at === stamp) {
        out.push(known.origin);
        continue;
      }
      const origin = await this.originOf(wt, agentId, at);
      this.cache.set(wt, { origin, at: stamp });
      out.push(origin);
    }
    return out;
  }
}
