import { describe, expect, it } from 'vitest';
import type { AgentOrigin } from '../src/core/claude-code/model.js';
import type { Project, Workspace } from '../src/workspaces/types.js';
import { type WorktreeFilter, archivedRows, archivedText, filterRows, totals, worktreeRows } from '../packages/mac/src/views/worktrees/worktrees-model.js';

/** Every worktree on this Mac in one list: who made it, whether its work is done, what it takes. */
describe('the Worktrees page', () => {
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, projectRoot: '/r', name: id, path: `/r/wt/${id}`, kind: 'worktree', createdAt: 0, projectId: 'p', external: false, branch: `beluga/${id}`, status: { changed: 0, ahead: 2, behind: 0 }, ...over });
  const main = ws('main', { kind: 'main', path: '/r', branch: 'main' });
  const chat = ws('ask', { kind: 'chat', path: '/r', name: 'How do deploys work?' });
  const mine = ws('add-auth');
  const merged = ws('old-fix', { status: { changed: 0, ahead: 3, behind: 9 } });
  const done = ws('nothing-new', { status: { changed: 0, ahead: 0, behind: 4 } });
  const busy = ws('wip', { status: { changed: 5, ahead: 0, behind: 0 } });
  const conductor = ws('berlin', { external: true, path: '/Users/me/conductor/workspaces/app/berlin', branch: 'berlin' });
  const agent = ws('agent-a1', { external: true, path: '/r/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1' });
  const orphan = ws('agent-b2', { external: true, path: '/r/.claude/worktrees/agent-b2', branch: 'worktree-agent-b2' });
  const unknown = ws('agent-c3', { external: true, path: '/r/.claude/worktrees/agent-c3' });
  const gone = ws('archived', { archived: true });
  const project: Project = { id: 'p', name: 'app', root: '/r', base: 'origin/main', workspaces: [main, chat, mine, merged, done, busy, conductor, agent, orphan, unknown, gone] };
  const origins: AgentOrigin[] = [
    { path: agent.path, agentId: 'a1', sessionId: 's1', sessionTitle: 'Split the work', workspaceId: 'add-auth', lastAt: 1, description: 'Composer package' },
    { path: orphan.path, agentId: 'b2', sessionId: 's2', sessionTitle: 'Future feature ideas', sessionCwd: '/Users/me/conductor/workspaces/app/macau', lastAt: 1, description: 'Terminal engine' },
  ];
  const state = {
    projects: [project],
    disk: { 'add-auth': 3e9, 'old-fix': 2e9, berlin: 4e9 },
    prs: { 'old-fix': { number: 7, url: '', state: 'MERGED' as const, title: 'Fix', draft: false, checks: 'none' as const } },
    claudeCode: { sessions: [], origins },
    archiving: { wip: 'compressing' as const },
  };
  const rows = worktreeRows(state as never);
  const by = (id: string) => rows.find((r) => r.ws.id === id)!;

  it('lists worktrees only: not the main folder, chats, or what’s archived', () => {
    expect(rows.map((r) => r.ws.id).sort()).toEqual(['add-auth', 'agent-a1', 'agent-b2', 'agent-c3', 'berlin', 'nothing-new', 'old-fix', 'wip']);
    // Biggest first.
    expect(rows[0]!.ws.id).toBe('berlin');
  });

  it('says who made each, and for a sub-agent, the conversation that started it (or that it’s gone)', () => {
    expect(by('add-auth').madeBy).toEqual({ kind: 'klaud', label: 'Klaud' });
    expect(by('berlin').madeBy).toEqual({ kind: 'outside', label: 'Made outside Klaud' });
    expect(by('agent-a1').madeBy).toMatchObject({ kind: 'agent', label: 'Sub-agent of “add-auth”', task: 'Composer package', parentId: 'add-auth' });
    expect(by('agent-b2').madeBy).toMatchObject({ kind: 'agent', label: 'Sub-agent of “Future feature ideas” (gone)', orphan: true });
    expect(by('agent-c3').madeBy).toMatchObject({ kind: 'agent', label: 'Sub-agent, origin unknown', orphan: true });
  });

  it('whether its work is done: merged, or nothing that isn’t in main yet', () => {
    expect(by('old-fix').work).toEqual({ done: true, label: 'Merged (#7)' });
    expect(by('nothing-new').work).toEqual({ done: true, label: 'Nothing new' });
    expect(by('add-auth').work).toEqual({ done: false, label: '2 commits not in main' });
    expect(by('wip').work).toEqual({ done: false, label: '5 uncommitted files' });
    expect(by('agent-c3').work.label).toBe('2 commits not in main');
    expect(by('wip').archiving).toBe('compressing');
  });

  it('filters: done, sub-agents, orphaned (who started it is gone), made outside Beluga', () => {
    const ids = (f: WorktreeFilter) => filterRows(rows, f).map((r) => r.ws.id).sort();
    expect(ids('done')).toEqual(['nothing-new', 'old-fix']);
    expect(ids('agents')).toEqual(['agent-a1', 'agent-b2', 'agent-c3']);
    expect(ids('orphaned')).toEqual(['agent-b2', 'agent-c3']);
    expect(ids('outside')).toEqual(['agent-a1', 'agent-b2', 'agent-c3', 'berlin']);
    expect(filterRows(rows, 'all', 'nope')).toEqual([]);
  });

  it('says what’s in each that isn’t in main, as numbers (unknown until git was asked)', () => {
    expect(by('wip').left).toEqual({ commits: 0, files: 5 });
    expect(by('add-auth').left).toEqual({ commits: 2, files: 0 });
    expect(worktreeRows({ ...state, projects: [{ ...project, workspaces: [ws('new', { status: undefined })] }] } as never)[0]!.left).toBeUndefined();
  });

  it('lists archived ones apart: whether each comes back, and what deleting it loses', () => {
    const smart = ws('smart', { archived: true, archive: { freedBytes: 9, keptBytes: 2048, remake: [], at: 5 } });
    const oldOne = ws('old', { archived: true, createdAt: 1 });
    const lost = ws('lost', { archived: true, branch: undefined, createdAt: 2 });
    const theirs = ws('theirs', { archived: true, external: true, path: '/elsewhere/theirs', branch: 'theirs', createdAt: 3 });
    const put = archivedRows({ ...state, projects: [{ ...project, workspaces: [mine, smart, oldOne, lost, theirs] }] } as never);
    expect(put.map((r) => r.ws.id)).toEqual(['smart', 'theirs', 'lost', 'old']);
    const of = (id: string) => put.find((r) => r.ws.id === id)!;
    expect(of('smart').archived).toMatchObject({ keptBytes: 2048, restorable: true });
    expect(of('lost').archived?.restorable).toBe(false);
    const fmt = (n: number) => `${n} B`;
    expect(archivedText(of('smart'), fmt).restore).toMatch(/as it was/);
    expect(archivedText(of('smart'), fmt).remove).toBe('Deleting loses its archive (uncommitted work and files of yours, 2048 B), its branch beluga/smart (commits only there) and its conversation.');
    expect(archivedText(of('old'), fmt).restore).toBe('Restore makes it again from its branch beluga/old');
    // Another tool's branch is never deleted.
    expect(archivedText(of('theirs'), fmt).remove).toBe('Deleting loses its conversation.');
    expect(archivedText(of('lost'), fmt).restore).toMatch(/Can’t come back/);
    // Only under Archived, and only they are.
    const both = [...rows, ...put];
    expect(filterRows(both, 'archived').map((r) => r.ws.id).sort()).toEqual(['lost', 'old', 'smart', 'theirs']);
    expect(filterRows(both, 'all').some((r) => r.archived)).toBe(false);
  });

  it('adds up what they take, and what clearing dependencies and caches would free', () => {
    const t = totals(rows, { 'add-auth': 2.5e9, berlin: 3.9e9, 'old-fix': 0 });
    expect(t).toMatchObject({ count: 8, bytes: 9e9, measured: 3 });
    expect(t.rebuildable).toBeCloseTo(6.4e9);
  });
});
