import { describe, expect, it } from 'vitest';
import { Store, initialState, type View } from '../src/core/store.js';
import type { ClaudeSkill } from '../src/shared/skills.js';
import { apiProxy, type BelugaClient } from '../src/ipc/client.js';
import { submitTyped } from '../src/ui/submit.js';
import { screenOver, waitFor } from './helpers.js';

describe('the first chat message', () => {
  it.each(['/deploy staging', '/git:sync main', '//review changes'])('starts a chat with the skill or custom command %s and the selected mode', (text) => {
    const domain = new Store(initialState('room'));
    domain.dispatch({ type: 'plan_mode', channel: 'draft', on: true });
    const { screen } = screenOver(domain);
    screen.dispatch({ type: 'view', view: { kind: 'draft', projectId: 'chats', dir: '/tmp/repo', back: { kind: 'overview' } } });
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const api = apiProxy(async (method, args) => {
      calls.push({ method, args });
    });
    submitTyped({ client: { store: screen, api } as BelugaClient, ui: () => ({}), patchUi: () => undefined, runUiAction: () => undefined }, text);
    expect(calls).toEqual([{ method: 'workspaces.startChat', args: ['chats', text.replace(/^\/\//, '/'), '/tmp/repo', { plan: true }] }]);
  });

  it.each([true, false])('sends the selected Plan mode through startChat (terminal: %s)', (terminal) => {
    const domain = new Store(initialState('room'));
    domain.dispatch({ type: 'plan_mode', channel: 'draft', on: true });
    const { screen } = screenOver(domain);
    screen.dispatch({ type: 'view', view: { kind: 'draft', projectId: 'chats', dir: '/tmp/repo', back: { kind: 'overview' } } });
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const api = apiProxy(async (method, args) => {
      calls.push({ method, args });
    });
    submitTyped({ client: { store: screen, api } as BelugaClient, ui: () => ({}), patchUi: () => undefined, runUiAction: () => undefined, toTerminal: () => terminal }, 'Explain this repo');
    expect(calls).toEqual([{ method: 'workspaces.startChat', args: ['chats', 'Explain this repo', '/tmp/repo', { plan: true, ...(terminal ? { terminal: true } : {}) }] }]);
  });
});

describe('slash command routing', () => {
  it('starts a draft with a skill that overrides an agent built-in', async () => {
    const calls = submitFrom({ kind: 'draft', projectId: 'chats', dir: '/tmp/repo', back: { kind: 'overview' } }, '/context explain', [{ name: 'context', description: 'Explain context', kind: 'skill', source: 'project' }]);
    await waitFor(() => calls.find((call) => call.method === 'workspaces.startChat'));
    expect(calls).toEqual([
      { method: 'claudeCode.skills', args: ['draft', '/tmp/repo'] },
      { method: 'workspaces.startChat', args: ['chats', '/context explain', '/tmp/repo'] },
    ]);
  });

  it.each(['/help', '/plan on', '/model', '/graph overview', '/who'])('keeps the Beluga command %s in the command handler', (text) => {
    const calls = submitFrom({ kind: 'draft', projectId: 'chats', back: { kind: 'overview' } }, text);
    expect(calls).toEqual([{ method: 'session.submit', args: [text, { channel: 'draft', urgent: false }] }]);
  });

  it.each(['/dialogue stop', '/dialogue claude codex talk about caching, 6 turns'])('keeps the dialogue command %s on the session path', (text) => {
    const calls = submitFrom({ kind: 'draft', projectId: 'chats', back: { kind: 'overview' } }, text);
    expect(calls).toEqual([{ method: 'session.submit', args: [text, { channel: 'draft', urgent: false }] }]);
  });

  it('keeps skills in an existing chat on the session path', () => {
    const calls = submitFrom({ kind: 'workspace', id: 'chat-one', tab: 'chat' }, '/deploy staging');
    expect(calls).toEqual([{ method: 'session.submit', args: ['/deploy staging', { channel: 'ws:chat-one', urgent: false }] }]);
  });
});

describe('draft agent command hints', () => {
  it.each([[], new Error('Skill discovery failed')])('keeps the agent built-in hint when no own skill is available (%s)', async (skills) => {
    const calls = submitFrom({ kind: 'draft', projectId: 'chats', back: { kind: 'overview' } }, '/context', skills);
    await waitFor(() => calls.find((call) => call.method === 'session.submit'));
    expect(calls).toEqual([
      { method: 'claudeCode.skills', args: ['draft', undefined] },
      { method: 'session.submit', args: ['/context', { channel: 'draft', urgent: false }] },
    ]);
  });
});

function submitFrom(view: View, text: string, skills: readonly ClaudeSkill[] | Error = []): Array<{ method: string; args: readonly unknown[] }> {
  const { screen } = screenOver(new Store(initialState('room')));
  screen.dispatch({ type: 'view', view });
  const calls: Array<{ method: string; args: readonly unknown[] }> = [];
  const api = apiProxy(async (method, args) => {
    calls.push({ method, args });
    if (method === 'claudeCode.skills' && skills instanceof Error) throw skills;
    return method === 'claudeCode.skills' ? skills : undefined;
  });
  submitTyped({ client: { store: screen, api } as BelugaClient, ui: () => ({}), patchUi: () => undefined, runUiAction: () => undefined }, text);
  return calls;
}
