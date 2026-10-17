import { describe, expect, it } from 'vitest';
import { transcriptToLog, type TranscriptMessage } from '../src/agent/transcript.js';
import { parseWorkspaceMention, workspaceMentions } from '../src/core/mentions.js';
import type { Project, Workspace } from '../src/workspaces/types.js';

const ws = (over: Partial<Workspace>): Workspace => ({ id: 'w1', projectRoot: '/p', name: 'add-auth', path: '/wt', kind: 'worktree', createdAt: 1, projectId: 'p1', external: false, ...over });

describe('Claude Code conversations from other tools', () => {
  const msg = (type: TranscriptMessage['type'], content: unknown, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ type, message: { content }, parent_tool_use_id: null, ...extra });

  it('shows your messages and one Claude card per turn, without tool output or sub-agent chatter', () => {
    const log = transcriptToLog(
      [
        msg('user', 'fix the login bug'),
        msg('assistant', [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Read', input: { file_path: '/wt/src/login.ts' } }]),
        msg('user', [{ type: 'tool_result', content: 'file text' }]),
        msg('assistant', [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }], { parent_tool_use_id: 'sub' }),
        msg('assistant', [{ type: 'text', text: 'Fixed: the redirect lost the session.' }]),
        msg('user', '<task-notification>done</task-notification>'),
        msg('assistant', [{ type: 'text', text: 'The background tests pass too.' }]),
        msg('assistant', [{ type: 'text', text: "You've hit your session limit" }], {}),
      ],
      { selfId: 'me', selfName: 'kay', cwd: '/wt', start: 1000, end: 2000 },
    );
    expect(log.map((l) => l.type)).toEqual(['chat', 'agent', 'agent']);
    const [you, first, second] = log;
    expect(you).toMatchObject({ type: 'chat', from: 'me', text: 'fix the login bug' });
    expect(first).toMatchObject({ type: 'agent', status: 'done', text: 'Fixed: the redirect lost the session.', steps: ['Read src/login.ts'] });
    expect(second?.type === 'agent' && second.text).toBe("You've hit your session limit");
  });

  it("skips Claude Code's own notices and summarizes a continued conversation", () => {
    const log = transcriptToLog(
      [
        msg('user', 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Build the thing'),
        { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] }, parent_tool_use_id: null },
      ],
      { selfId: 'me', selfName: 'kay', cwd: '/wt', start: 0, end: 0 },
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: 'system' });
    expect(log[0]?.type === 'system' && log[0].text).toContain('1. Build the thing');
  });
});

describe('@workspace from the main chat', () => {
  const projects: Project[] = [
    { id: 'p1', name: 'api', root: '/p', base: 'origin/main', workspaces: [ws({ id: 'm', name: 'main', kind: 'main' }), ws({}), ws({ id: 'agent', name: 'agent-a1', path: '/p/.claude/worktrees/agent-a1', external: true })] },
    { id: 'p2', name: 'web', root: '/q', base: 'origin/main', workspaces: [ws({ id: 'm2', name: 'main', kind: 'main', projectId: 'p2' }), ws({ id: 'w2', name: 'Fix Header!', projectId: 'p2' })] },
  ];

  it('names every workspace, disambiguating repeats, and skips agent worktrees', () => {
    expect(workspaceMentions(projects).map((m) => m.label)).toEqual(['@api/main', '@add-auth', '@web/main', '@fix-header']);
  });

  it('parses "@name message" only for real workspaces', () => {
    const m = workspaceMentions(projects);
    expect(parseWorkspaceMention('@add-auth   add a test', m)).toEqual({ id: 'w1', label: '@add-auth', prompt: 'add a test' });
    expect(parseWorkspaceMention('@web/main deploy', m)?.id).toBe('m2');
    expect(parseWorkspaceMention('@claude hi', m)).toBeUndefined();
    expect(parseWorkspaceMention('@add-auth', m)).toBeUndefined();
  });
});
