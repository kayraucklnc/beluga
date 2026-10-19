import { describe, expect, it } from 'vitest';
import type { CcAgent, CcSession, CcTask } from '../src/core/claude-code/model.js';
import { taskLabel, tasksForAgent, tasksForWorkspace } from '../packages/mac/src/claude-code/background-model.js';

/** Background commands as the Mac app shows them: where, who started them, how they're doing. */
describe('background commands in the Mac app', () => {
  const task = (id: string, extra: Partial<CcTask> = {}): CcTask => ({ id, kind: 'command', description: id, command: 'npm run dev', status: 'running', startedAt: 1000, ...extra });
  const agent = (id: string, extra: Partial<CcAgent> = {}): CcAgent => ({ id, description: `Agent ${id}`, type: 'general-purpose', background: true, status: 'running', startedAt: 1, lastAt: 2, steps: 1, ...extra });
  const session = (id: string, workspaceId: string | undefined, tasks: CcTask[], agents: CcAgent[] = []): CcSession => ({ id, title: id, cwd: '/w', status: 'working', lastAt: 1, steps: 1, agents, tasks, ...(workspaceId ? { workspaceId } : {}) });
  const WT = '/r/.claude/worktrees/agent-a2';

  it("a workspace's: every session there and its agents', running first; an agent working in its own worktree shows there", () => {
    const sessions = [
      session('s1', 'w1', [task('dev', { startedAt: 10 }), task('tests', { status: 'failed', startedAt: 20 }), task('build', { agentId: 'a1', startedAt: 30 }), task('e2e', { agentId: 'a2', startedAt: 40 })], [agent('a1'), agent('a2', { worktree: { path: WT } })]),
      session('s2', 'w2', [task('other')]),
    ];
    expect(tasksForWorkspace(sessions, { id: 'w1', path: '/w' }).map((t) => [t.task.id, t.who])).toEqual([
      ['build', 'Agent a1'],
      ['dev', 'Claude'],
      ['tests', 'Claude'],
    ]);
    expect(tasksForWorkspace(sessions, { id: 'wt', path: WT }).map((t) => [t.task.id, t.sessionId])).toEqual([['e2e', 's1']]);
    expect(tasksForAgent(sessions[0]!, 'a1').map((t) => t.task.id)).toEqual(['build']);
  });

  it('says how each is doing, briefly', () => {
    const now = 1000 + 3 * 60_000;
    expect(taskLabel(task('x'), now)).toEqual({ label: 'Running · 3m', tone: 'claude' });
    expect(taskLabel(task('x', { status: 'failed', exitCode: 2, endedAt: now - 60_000 }), now)).toEqual({ label: 'Failed · exit 2 · 1m ago', tone: 'error' });
    expect(taskLabel(task('x', { status: 'finished', exitCode: 0, endedAt: now - 5000 }), now)).toEqual({ label: 'Done · 5s ago', tone: 'ok' });
    expect(taskLabel(task('x', { status: 'stopped', endedAt: now }), now)).toEqual({ label: 'Stopped · 0s ago', tone: 'muted' });
    expect(taskLabel(task('x', { status: 'idle' }), now)).toEqual({ label: 'No word from it · 3m', tone: 'muted' });
    expect(taskLabel(task('x', { kind: 'monitor' }), now).label).toBe('Watching · 3m');
  });
});
