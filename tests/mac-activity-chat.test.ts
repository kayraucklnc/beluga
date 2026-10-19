import { describe, expect, it } from 'vitest';
import { chatOf } from '../packages/mac/src/claude-code/chat-of.js';

describe('Activity opens the chat a session belongs to', () => {
  const ws = (id: string, extra: object) => ({ id, kind: 'worktree', external: true, archived: false, ...extra });
  const projects = [{ workspaces: [ws('conductor', {}), ws('old', { archived: true }), ws('mine', { external: false }), ws('main', { kind: 'main', external: false })] }] as never;

  it('a worktree made outside Klaud opens its chat; anything else stays a live transcript', () => {
    expect(chatOf({ projects }, { workspaceId: 'conductor' })).toBe('conductor');
    expect(chatOf({ projects }, { workspaceId: 'old' })).toBeUndefined();
    expect(chatOf({ projects }, { workspaceId: 'mine' })).toBeUndefined();
    expect(chatOf({ projects }, { workspaceId: 'main' })).toBeUndefined();
    expect(chatOf({ projects }, { workspaceId: 'gone' })).toBeUndefined();
    expect(chatOf({ projects }, {})).toBeUndefined();
  });
});
