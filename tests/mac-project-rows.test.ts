import { describe, expect, it } from 'vitest';
import type { CcAgent, CcSession } from '../src/core/claude-code/model.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { hasRowsInside } from '../packages/mac/src/layout/project-rows.js';

/** A project's fold arrow shows only when unfolding it would show something. */
describe('what a project has inside', () => {
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, projectRoot: '/r', name: id, path: `/r/${id}`, kind: 'worktree', createdAt: 0, projectId: 'p', external: false, ...over });
  const main = ws('main', { kind: 'main', path: '/r' });
  const project = (...workspaces: Workspace[]): Project => ({ id: 'p', name: 'p', root: '/r', base: 'main', workspaces: [main, ...workspaces] });
  const agent = (id: string, extra: Partial<CcAgent> = {}): CcAgent => ({ id, description: id, type: 'general-purpose', background: true, status: 'finished', startedAt: 1, lastAt: 2, steps: 1, ...extra });
  const session = (agents: CcAgent[], workspaceId: string): CcSession => ({ id: 's', title: 's', cwd: '/r', status: 'idle', lastAt: 1, steps: 1, agents, own: true, workspaceId });

  it('nothing: just the main folder, or only archived work', () => {
    expect(hasRowsInside(project(), [])).toBe(false);
    expect(hasRowsInside(project(ws('old', { archived: true })), [])).toBe(false);
  });

  it('its worktrees and chats, worktrees made outside Klaud', () => {
    expect(hasRowsInside(project(ws('feature')), [])).toBe(true);
    expect(hasRowsInside(project(ws('chat', { kind: 'chat' as Workspace['kind'] })), [])).toBe(true);
    expect(hasRowsInside(project(ws('theirs', { external: true, path: '/elsewhere/theirs' })), [])).toBe(true);
  });

  it('sub-agents started in the main folder, and sub-agent worktrees on their own', () => {
    expect(hasRowsInside(project(), [session([agent('a1')], 'main')])).toBe(true);
    expect(hasRowsInside(project(ws('agent-x', { external: true, path: '/r/.claude/worktrees/agent-x' })), [])).toBe(true);
  });
});
