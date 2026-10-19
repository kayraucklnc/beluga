import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readMeta } from './agents.js';
import { headLines } from './tail.js';
import { parseLine } from './transcript.js';

/**
 * The worktrees Claude Code's sub-agents made for themselves (`isolation: worktree`), found from
 * the folder of the conversation that started them: every session Claude Code ran there, and each
 * of its sub-agents' (and their sub-agents') side files. So they can go with that conversation.
 * Reads only.
 */

const SESSION_FILE = /^([0-9a-f-]{8,64})\.jsonl$/i;
const META_FILE = /^agent-[\w-]+\.meta\.json$/;

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** The folder a session ran in, as its transcript says (Claude Code's folder names can't be told apart). */
function cwdOf(file: string): string | undefined {
  for (const line of headLines(file, 64 * 1024)) {
    const cwd = parseLine(line)?.cwd;
    if (cwd) return cwd;
  }
  return undefined;
}

export interface AgentWorktree {
  /** Full path. */
  readonly path: string;
  /** The agent's last write (its transcript, else its side file), ms. */
  readonly lastAt: number;
}

const mtime = (file: string): number => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;

/** The worktrees sub-agents started from conversations in `cwd` made. */
export function agentWorktreesOf(home: string, cwd: string): AgentWorktree[] {
  const folder = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const found = new Map<string, AgentWorktree>();
  for (const name of list(folder)) {
    const id = SESSION_FILE.exec(name)?.[1];
    if (!id || cwdOf(path.join(folder, name)) !== cwd) continue;
    const agents = path.join(folder, id, 'subagents');
    for (const meta of list(agents)) {
      // readMeta only believes a worktree where Claude Code makes them.
      const wt = META_FILE.test(meta) ? readMeta(path.join(agents, meta)).worktreePath : undefined;
      if (!wt) continue;
      const lastAt = Math.max(mtime(path.join(agents, meta)), mtime(path.join(agents, meta.replace(/\.meta\.json$/, '.jsonl'))));
      found.set(wt, { path: wt, lastAt: Math.max(lastAt, found.get(wt)?.lastAt ?? 0) });
    }
  }
  return [...found.values()];
}
