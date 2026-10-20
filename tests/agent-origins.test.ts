import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentOrigins } from '../src/core/claude-code/agent-origins.js';

/** Who started a sub-agent's worktree, from Claude Code's files, long after Klaud stopped following it. */
describe('where a sub-agent worktree came from', () => {
  let home: string;
  const ROOT = '/work/app';
  const WT = (id: string) => `${ROOT}/.claude/worktrees/agent-${id}`;
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  const session = (cwd: string, id: string, agents: Record<string, object>, extra = ''): void => {
    const folder = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(path.join(folder, id, 'subagents'), { recursive: true });
    writeFileSync(path.join(folder, `${id}.jsonl`), line({ type: 'user', sessionId: id, cwd, message: { content: '<system>ignore me</system>' } }) + line({ type: 'user', sessionId: id, cwd, message: { content: 'Split the work into packages' } }) + extra);
    for (const [agent, meta] of Object.entries(agents)) writeFileSync(path.join(folder, id, 'subagents', `agent-${agent}.meta.json`), JSON.stringify(meta));
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-agent-origins-')));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds the session that started each one: its folder, its title, what the agent was asked', () => {
    session(ROOT, 'aaaaaaaa-0000-0000-0000-000000000001', { a1: { worktreePath: WT('a1'), worktreeBranch: 'feat/a1', description: 'Composer package', agentType: 'general-purpose', finished: true } }, line({ type: 'ai-title', aiTitle: 'Klaud terminal work' }));
    session('/elsewhere/macau', 'aaaaaaaa-0000-0000-0000-000000000002', { b1: { worktreePath: WT('b1'), description: 'Terminal engine' } });
    const found = new AgentOrigins(home).find([WT('a1'), WT('b1'), WT('nobody')]);
    expect(found).toHaveLength(2);
    const a1 = found.find((o) => o.agentId === 'a1')!;
    expect(a1).toMatchObject({ path: WT('a1'), sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', sessionCwd: ROOT, sessionTitle: 'Klaud terminal work', description: 'Composer package', branch: 'feat/a1', finished: true });
    expect(a1.lastAt).toBeGreaterThan(0);
    // No title yet: its first real message.
    expect(found.find((o) => o.agentId === 'b1')).toMatchObject({ sessionCwd: '/elsewhere/macau', sessionTitle: 'Split the work into packages' });
  });

  it('by the folder’s name when the side file doesn’t say where its worktree is', () => {
    session(ROOT, 'aaaaaaaa-0000-0000-0000-000000000003', { c1: { description: 'Old agent' } });
    expect(new AgentOrigins(home).find([WT('c1')])[0]).toMatchObject({ agentId: 'c1', description: 'Old agent' });
  });

  it('looks again for one it didn’t know (a new agent), not on every call', () => {
    const origins = new AgentOrigins(home, { retryMs: 0 });
    expect(origins.find([WT('late')])).toEqual([]);
    session(ROOT, 'aaaaaaaa-0000-0000-0000-000000000004', { late: { worktreePath: WT('late') } });
    expect(origins.find([WT('late')])[0]?.agentId).toBe('late');
    const slow = new AgentOrigins(home, { retryMs: 60_000 });
    expect(slow.find([WT('later')])).toEqual([]);
    session(ROOT, 'aaaaaaaa-0000-0000-0000-000000000005', { later: { worktreePath: WT('later') } });
    expect(slow.find([WT('later')])).toEqual([]);
  });

  it('nothing for folders that aren’t sub-agent worktrees, or without a Claude Code folder', () => {
    expect(new AgentOrigins(home).find(['/work/app/wt/feature'])).toEqual([]);
    expect(new AgentOrigins(path.join(home, 'missing')).find([WT('a1')])).toEqual([]);
  });
});
