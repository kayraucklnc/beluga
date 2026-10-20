import { describe, expect, it } from 'vitest';
import type { CcAgent, CcSession } from '../src/core/claude-code/model.js';
import { agentIdOfPath, agentOfToolUse, agentOfWorktree, agentTitle, effortLabel, isAgentWorktree, modelLabel, steerPrompt, steerable, subAgentsUnder } from '../packages/mac/src/claude-code/subagents-model.js';

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

  it('nests a conversation’s own sub-agents under it, running first (their helpers stay inside them)', () => {
    expect(subAgentsUnder([mine, outside], 'ws1').map((s) => s.agent.id)).toEqual(['live1', 'x', 'a09dac5d30f83f08a']);
    expect(steerable({ agent: live, session: mine })).toBe(true);
    expect(steerable({ agent: agent('x'), session: outside })).toBe(false);
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
