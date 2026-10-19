import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentWorktreesOf } from '../src/core/claude-code/agent-worktrees.js';

/** The worktrees sub-agents made, found from the folder of the conversation that started them. */
describe('sub-agent worktrees of a folder', () => {
  let home: string;
  const CWD = '/work/app/wt/feature';
  const ROOT = '/work/app';
  const folderOf = (cwd: string) => path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const session = (cwd: string, id: string, agents: Record<string, object>, writtenCwd = cwd): void => {
    const folder = folderOf(cwd);
    mkdirSync(path.join(folder, id, 'subagents'), { recursive: true });
    writeFileSync(path.join(folder, `${id}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: id, cwd: writtenCwd, message: { content: 'hi' } })}\n`);
    for (const [agent, meta] of Object.entries(agents)) writeFileSync(path.join(folder, id, 'subagents', `agent-${agent}.meta.json`), JSON.stringify(meta));
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-agent-wt-')));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reads every session there, its sub-agents (and theirs) with a worktree of their own', () => {
    session(CWD, 'aaaaaaaa-0000-0000-0000-000000000001', {
      a1: { worktreePath: `${ROOT}/.claude/worktrees/agent-a1` },
      a2: { description: 'no worktree' },
      a3: { worktreePath: `${ROOT}/.claude/worktrees/agent-a3`, parentAgentId: 'a1' },
    });
    session(CWD, 'aaaaaaaa-0000-0000-0000-000000000002', { b1: { worktreePath: `${ROOT}/.claude/worktrees/agent-b1` } });
    expect(agentWorktreesOf(home, CWD).map((a) => a.path).sort()).toEqual([`${ROOT}/.claude/worktrees/agent-a1`, `${ROOT}/.claude/worktrees/agent-a3`, `${ROOT}/.claude/worktrees/agent-b1`]);
  });

  it('never a worktree outside where Claude Code makes them, another folder’s, or a folder whose name only looks the same', () => {
    session(CWD, 'aaaaaaaa-0000-0000-0000-000000000003', { x: { worktreePath: '/etc' } });
    session('/work/app/wt/other', 'aaaaaaaa-0000-0000-0000-000000000004', { o: { worktreePath: `${ROOT}/.claude/worktrees/agent-o` } });
    // "/work/app/wt-feature" is stored under the same name as "/work/app/wt/feature".
    session(CWD, 'aaaaaaaa-0000-0000-0000-000000000005', { y: { worktreePath: `${ROOT}/.claude/worktrees/agent-y` } }, '/work/app/wt-feature');
    expect(agentWorktreesOf(home, CWD)).toEqual([]);
    expect(agentWorktreesOf(home, '/work/app/wt/other')[0]?.lastAt).toBeGreaterThan(0);
    expect(agentWorktreesOf(home, '/nowhere')).toEqual([]);
    expect(agentWorktreesOf(path.join(home, 'missing'), CWD)).toEqual([]);
  });
});
