import type { CcSession, CcTask } from '../../../../src/core/claude-code/model.js';

/**
 * Background commands (a dev server, the full tests, a build) and watches that Claude or its
 * agents started, as the Mac app shows them: which belong to a workspace, who started each, and
 * how it's doing. Pure (tests/mac-background.test.ts).
 */

export interface TaskItem {
  readonly task: CcTask;
  readonly sessionId: string;
  /** "Claude", or the agent that started it. */
  readonly who: string;
}

export type TaskTone = 'claude' | 'ok' | 'error' | 'muted';

const byLiveThenLatest = (a: TaskItem, b: TaskItem): number => Number(b.task.status === 'running') - Number(a.task.status === 'running') || b.task.startedAt - a.task.startedAt;

function itemsOf(s: CcSession): TaskItem[] {
  return (s.tasks ?? []).map((task) => {
    const agent = task.agentId ? s.agents.find((a) => a.id === task.agentId) : undefined;
    return { task, sessionId: s.id, who: agent ? agent.description || agent.name || 'An agent' : task.agentId ? 'An agent' : 'Claude' };
  });
}

/**
 * A workspace's: those the conversations there (and their agents) started, but an agent working
 * in its own worktree shows its commands there instead.
 */
export function tasksForWorkspace(sessions: readonly CcSession[], ws: { readonly id: string; readonly path: string }): TaskItem[] {
  return sessions
    .flatMap((s) =>
      itemsOf(s).filter((it) => {
        const own = it.task.agentId ? s.agents.find((a) => a.id === it.task.agentId)?.worktree?.path : undefined;
        return own ? own === ws.path : s.workspaceId === ws.id;
      }),
    )
    .sort(byLiveThenLatest);
}

/** One agent's. */
export const tasksForAgent = (s: CcSession, agentId: string): TaskItem[] => itemsOf(s).filter((it) => it.task.agentId === agentId).sort(byLiveThenLatest);

function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "Running · 3m", "Failed · exit 2 · 1m ago", "Done · 5s ago". */
export function taskLabel(t: CcTask, now: number): { label: string; tone: TaskTone } {
  const ago = `${since(now - (t.endedAt ?? now))} ago`;
  const exit = t.exitCode !== undefined && t.exitCode !== 0 ? ` · exit ${t.exitCode}` : '';
  switch (t.status) {
    case 'running':
      return { label: `${t.kind === 'monitor' ? 'Watching' : 'Running'} · ${since(now - t.startedAt)}`, tone: 'claude' };
    case 'failed':
      return { label: `Failed${exit} · ${ago}`, tone: 'error' };
    case 'finished':
      return { label: `Done${exit} · ${ago}`, tone: 'ok' };
    case 'stopped':
      return { label: `Stopped · ${ago}`, tone: 'muted' };
    default:
      return { label: `No word from it · ${since(now - t.startedAt)}`, tone: 'muted' };
  }
}
