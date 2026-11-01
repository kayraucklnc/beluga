import { describe, expect, it } from 'vitest';
import { Store, initialState } from '../src/core/store.js';
import { apiProxy, type BelugaClient } from '../src/ipc/client.js';
import { submitTyped } from '../src/ui/submit.js';
import { screenOver } from './helpers.js';

describe('the first chat message', () => {
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
