import { describe, expect, it } from 'vitest';
import type { AgentOrigin, CcAgent, CcSession } from '../src/core/claude-code/model.js';
import { agentIdOfPath, agentResidue, agentOfToolUse, agentOfWorktree, agentTitle, byStart, cappedAgents, effortLabel, inStartOrder, isAgentWorktree, modelLabel, steerPrompt, steerable, subAgentsSummary, subAgentsUnder } from '../packages/mac/src/claude-code/subagents-model.js';

const agent = (id: string, extra: Partial<CcAgent> = {}): CcAgent => ({ id, description: `Task ${id}`, type: 'general-purpose', background: true, status: 'finished', startedAt: 1, lastAt: 2, steps: 3, ...extra });
const session = (id: string, agents: CcAgent[], extra: Partial<CcSession> = {}): CcSession => ({ id, title: id, cwd: '/r', status: 'idle', lastAt: 1, steps: 1, agents, ...extra });
const WT = '/r/.claude/worktrees/agent-a09dac5d30f83f08a';

describe('sub-agents in the Mac app', () => {
  const live = agent('live1', { status: 'running', lastAt: 10, toolUseId: 'toolu_1' });
  const isolated = agent('a09dac5d30f83f08a', { worktree: { path: WT, branch: 'worktree-agent-a09dac5d30f83f08a' } });
  const nested = agent('kid', { parentAgentId: 'live1' });
  const mine = session('s1', [isolated, live, nested], { own: true, workspaceId: 'ws1' });
  const outside = session('s2', [agent('x', { lastAt: 5 })], { workspaceId: 'ws1' });

  it('finds a worktree’s agent, by what Claude Code recorded or the folder’s name', () => {
    expect(agentIdOfPath(WT)).toBe('a09dac5d30f83f08a');
    expect(agentIdOfPath('/r/worktrees/agent-x')).toBeUndefined();
    expect(agentOfWorktree([mine], { path: WT })?.agent.id).toBe('a09dac5d30f83f08a');
    expect(agentOfWorktree([session('s', [agent('a09dac5d30f83f08a')])], { path: WT })?.agent.id).toBe('a09dac5d30f83f08a');
    expect(agentOfToolUse([mine], 'toolu_1')?.agent.id).toBe('live1');
    expect(isAgentWorktree({ kind: 'worktree', external: true, path: WT })).toBe(true);
    expect(isAgentWorktree({ kind: 'worktree', external: true, path: '/r/wt/feature' })).toBe(false);
  });

  it('nests a conversation’s own sub-agents under it, in start order (their helpers stay inside them)', () => {
    // All started at the same moment here: by id.
    expect(subAgentsUnder([mine, outside], 'ws1').map((s) => s.agent.id)).toEqual(['a09dac5d30f83f08a', 'live1', 'x']);
    expect(steerable({ agent: live, session: mine })).toBe(true);
    expect(steerable({ agent: agent('x'), session: outside })).toBe(false);
  });

  it('keeps finished ones under what started them, from Claude Code’s files (the live one wins)', () => {
    const origin = (agentId: string, extra: Partial<AgentOrigin> = {}): AgentOrigin => ({ path: `/r/.claude/worktrees/agent-${agentId}`, agentId, sessionId: 'old', sessionTitle: 'Split it up', lastAt: 1, workspaceId: 'ws1', finished: true, ...extra });
    const list = subAgentsUnder([mine], 'ws1', [origin('past1', { description: 'Composer package', lastAt: 3 }), origin('a09dac5d30f83f08a'), origin('gone', { workspaceId: undefined }), origin('other', { workspaceId: 'ws2' })]);
    // A past one started (as far as is known) when it last wrote: after the live ones started.
    expect(list.map((s) => s.agent.id)).toEqual(['a09dac5d30f83f08a', 'live1', 'past1']);
    const past = list.find((s) => s.agent.id === 'past1')!;
    expect(past.past).toBe(true);
    expect(past.agent).toMatchObject({ description: 'Composer package', status: 'finished', worktree: { path: '/r/.claude/worktrees/agent-past1' } });
    expect(past.session).toMatchObject({ id: 'old', title: 'Split it up', workspaceId: 'ws1' });
    // Live, it's the watched one (not a second row).
    expect(list.find((s) => s.agent.id === 'a09dac5d30f83f08a')?.past).toBeUndefined();
  });

  it('keeps rows where they are while agents work and finish (BLG-21)', () => {
    const at = (id: string, startedAt: number, extra: Partial<CcAgent> = {}): CcAgent => agent(id, { startedAt, lastAt: startedAt, ...extra });
    const before = session('s1', [at('c', 30, { status: 'running', lastAt: 99 }), at('a', 10), at('b', 20, { status: 'running' }), at('d', 40)], { own: true, workspaceId: 'ws1' });
    const ids = (ss: CcSession[]): string[] => subAgentsUnder(ss, 'ws1').map((s) => s.agent.id);
    expect(ids([before])).toEqual(['a', 'b', 'c', 'd']);
    // b finishes, a writes again, the daemon sends them in another order: nothing moves.
    const after = session('s1', [at('d', 40, { status: 'running', lastAt: 200 }), at('b', 20, { status: 'finished', lastAt: 150 }), at('c', 30, { status: 'failed' }), at('a', 10, { lastAt: 300 })], { own: true, workspaceId: 'ws1' });
    expect(ids([after])).toEqual(['a', 'b', 'c', 'd']);
    // Same start: by id, whatever order they came in.
    expect(inStartOrder([at('z', 5), at('m', 5), at('k', 1)]).map((a) => a.id)).toEqual(['k', 'm', 'z']);
    expect([at('y', 5), at('x', 5)].sort(byStart).map((a) => a.id)).toEqual(['x', 'y']);
  });

  it('shows the newest few of a long list, the same set until a new one starts', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    expect(cappedAgents(list, 3)).toEqual({ shown: ['c', 'd', 'e'], hidden: 2 });
    // The one you're looking at shows too, in its place.
    expect(cappedAgents(list, 3, (x) => x === 'a')).toEqual({ shown: ['a', 'c', 'd', 'e'], hidden: 1 });
    expect(cappedAgents(['a', 'b'], 3)).toEqual({ shown: ['a', 'b'], hidden: 0 });
    // A new one starting: the oldest shown one tucks away; nothing else changes.
    expect(cappedAgents([...list, 'f'], 3).shown).toEqual(['d', 'e', 'f']);
    // Status plays no part: the same list in, the same rows out.
    const subs = (statuses: CcAgent['status'][]) => statuses.map((st, i) => ({ agent: agent(`a${i}`, { startedAt: i, status: st }), session: mine }));
    const shownIds = (statuses: CcAgent['status'][]) => cappedAgents(subAgentsUnder([session('s', subs(statuses).map((x) => x.agent), { workspaceId: 'w' })], 'w'), 3).shown.map((x) => x.agent.id);
    expect(shownIds(['running', 'running', 'finished', 'running', 'running'])).toEqual(shownIds(['finished', 'failed', 'running', 'finished', 'idle']));
  });

  it('sums up a folded group plainly', () => {
    const subs = (n: number, running: number) => Array.from({ length: n }, (_, i) => ({ agent: agent(`a${i}`, { status: i < running ? 'running' : 'finished' }) }));
    expect(subAgentsSummary(subs(4, 1))).toBe('4 sub-agents · 1 running');
    expect(subAgentsSummary(subs(3, 0))).toBe('3 sub-agents');
    expect(subAgentsSummary(subs(1, 1))).toBe('1 sub-agent · 1 running');
  });

  it('says plainly what a sub-agent left, and only clears what has nothing to lose', () => {
    const wt = { path: WT, branch: 'worktree-agent-x' };
    const done = { agent: agent('d', { worktree: wt }), session: mine };
    expect(agentResidue(done, { status: { changed: 1, ahead: 2, behind: 0 } })).toMatchObject({ kind: 'some', short: '2 commits · 1 file', clearable: false });
    expect(agentResidue(done, { status: { changed: 1, ahead: 2, behind: 0 } }).long).toBe('Left 2 commits not in main and 1 uncommitted file in its worktree (branch worktree-agent-x). Archiving it keeps them.');
    expect(agentResidue(done, { status: { changed: 0, ahead: 0, behind: 3 } })).toMatchObject({ kind: 'none', short: 'Nothing left', clearable: true });
    expect(agentResidue(done, {})).toMatchObject({ kind: 'unknown', clearable: false });
    // Its worktree is gone already.
    expect(agentResidue(done)).toMatchObject({ kind: 'none', clearable: true });
    // No worktree of its own: it worked in its parent's folder.
    expect(agentResidue({ agent: agent('s'), session: mine })).toMatchObject({ kind: 'shared', clearable: true });
    // Still working: never cleared.
    expect(agentResidue({ agent: agent('r', { status: 'running' }), session: mine }).clearable).toBe(false);
    expect(agentResidue({ agent: agent('r', { status: 'running', worktree: wt }), session: mine }, { status: { changed: 0, ahead: 0, behind: 0 } }).clearable).toBe(false);
  });

  it('says models, effort and names plainly; steering goes through the lead Claude', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-5-5-20261001')).toBe('Sonnet 5.5');
    expect(modelLabel('sonnet')).toBe('Sonnet');
    expect(modelLabel(undefined)).toBeUndefined();
    expect(effortLabel('medium')).toBe('Medium effort');
    expect(agentTitle(agent('abcdef123', { description: 'Sub-agent' }))).toBe('Agent abcdef1');
    const p = steerPrompt(live, ' use the staging DB ');
    expect(p).toContain('use the staging DB');
    expect(p).toContain('SendMessage (to: "live1")');
    expect(steerPrompt(agent('done1', { name: 'reviewer' }), 'check X')).toMatch(/It has stopped; continue it with SendMessage \(to: "reviewer"\)/);
  });
});
