import { describe, expect, it } from 'vitest';
import { ClientStore } from '../src/client/client-store.js';
import { Store, initialState } from '../src/core/store.js';

/** A sidebar click shows the workspace at once (ClientStore.openAhead); the daemon's later answer doesn't move the screen again. */
describe('opening a workspace ahead of the daemon', () => {
  const view = (c: ClientStore) => c.getState().view;
  const nav = (id: string) => ({ type: 'navigate' as const, view: { kind: 'workspace' as const, id, tab: 'chat' as const } });

  it('shows it now, and its echo is dropped even after a later click moved on', () => {
    const c = new ClientStore(new Store(initialState('room')));
    c.openAhead('a', 'chat');
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
    c.openAhead('b', 'chat');
    // The daemon catches up: its answer to "a" must not take you back from "b".
    c.applyIntent(nav('a'));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'b', tab: 'chat' });
    c.applyIntent(nav('b'));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'b', tab: 'chat' });
    // Anything the daemon asks for on its own still shows.
    c.applyIntent(nav('a'));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
  });
});
