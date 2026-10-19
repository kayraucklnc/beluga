import { readFileSync } from 'node:fs';
import type { CcAgentStatus } from './model.js';
import type { TaskNotice, ToolResult } from './transcript.js';

/**
 * A sub-agent's side file (agent-<id>.meta.json) and how klaud tells whether it's still working:
 * the session's word on it (a task notification, or the result of a foreground agent's call)
 * when it's newer than the agent's last write, else the agent's own transcript.
 */

export interface AgentMeta {
  readonly agentType?: string;
  readonly description?: string;
  readonly toolUseId?: string;
  /** "background" for agents the session sent off to work on their own. */
  readonly requestShape?: string;
  /** The model it was asked to use ("sonnet"), when not the session's. */
  readonly model?: string;
  /** Its own worktree (`isolation: worktree`): <project>/.claude/worktrees/agent-<id>, and that worktree's branch. */
  readonly worktreePath?: string;
  readonly worktreeBranch?: string;
  /** The agent that started it, when an agent did (not the session itself). */
  readonly parentAgentId?: string;
  /** The name it can be messaged by. */
  readonly name?: string;
}

const MAX_META = 64 * 1024;
const str = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Read the meta file; {} when it's missing, too big or broken. */
export function readMeta(file: string): AgentMeta {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length > MAX_META) return {};
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const key of ['agentType', 'description', 'toolUseId', 'requestShape', 'model', 'worktreeBranch', 'parentAgentId', 'name'] as const) {
      const v = str(raw[key]);
      if (v) out[key] = v;
    }
    // A worktree is only believed where Claude Code makes them (never somewhere else on disk).
    const worktree = str(raw.worktreePath, 4096);
    if (worktree && /[\\/]\.claude[\\/]worktrees[\\/]agent-[\w-]+$/.test(worktree)) out.worktreePath = worktree;
    return out;
  } catch {
    return {};
  }
}

/** Claude Code's word for how a task ended → ours. */
export function noticeStatus(status: string): Exclude<CcAgentStatus, 'running' | 'idle'> {
  const s = status.toLowerCase();
  if (s === 'failed' || s === 'error' || s === 'errored') return 'failed';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled' || s === 'canceled' || s === 'interrupted' || s === 'aborted') return 'stopped';
  return 'finished';
}

export interface StatusInput {
  /** The agent's last write. */
  readonly lastAt: number;
  /** Its last entry was a final answer. */
  readonly final: boolean;
  /** The session's latest notification about it. */
  readonly notice?: TaskNotice;
  /** The result of the call that started it (a foreground agent ends with it). */
  readonly result?: ToolResult;
  readonly now: number;
  /** No writes for this long and no final answer: idle. */
  readonly idleMs: number;
}

/** Writes this close after the session's word on it still count as before it (clocks, buffering). */
const SLACK_MS = 3000;

/** running / finished / failed / stopped / idle, and when it ended. */
export function agentStatus(i: StatusInput): { status: CcAgentStatus; endedAt?: number } {
  // A resumed agent writes again after it was reported: it's working again.
  if (i.notice && i.notice.ts + SLACK_MS >= i.lastAt) return { status: noticeStatus(i.notice.status), endedAt: i.notice.ts };
  if (i.result && !i.result.async && i.result.ts + SLACK_MS >= i.lastAt) return { status: i.result.error ? 'failed' : 'finished', endedAt: i.result.ts };
  if (i.final) return { status: 'finished', endedAt: i.lastAt };
  if (i.now - i.lastAt > i.idleMs) return { status: 'idle' };
  return { status: 'running' };
}
