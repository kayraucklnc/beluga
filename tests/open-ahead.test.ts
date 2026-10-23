import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientStore } from '../src/client/client-store.js';
import { Store, initialState } from '../src/core/store.js';

/** A sidebar click shows the workspace at once (ClientStore.openAhead); the daemon's later answer doesn't move the screen again. */
describe('opening a workspace ahead of the daemon', () => {
  type Tab = 'chat' | 'files' | 'review' | 'terminal';
  const view = (c: ClientStore) => c.getState().view;
  const nav = (id: string, tab: Tab = 'chat', req?: string) => ({ type: 'navigate' as const, view: { kind: 'workspace' as const, id, tab }, ...(req ? { req } : {}) });
  const away = (c: ClientStore) => c.dispatch({ type: 'view', view: { kind: 'room' } });

  afterEach(() => vi.useRealTimers());

  it('shows it now, and its echo is dropped even after a later click moved on', () => {
    const c = new ClientStore(new Store(initialState('room')));
    const a = c.openAhead('a', 'chat');
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
    const b = c.openAhead('b', 'chat');
    // The daemon catches up: its answer to "a" must not take you back from "b".
    c.applyIntent(nav('a', 'chat', a));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'b', tab: 'chat' });
    c.applyIntent(nav('b', 'chat', b));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'b', tab: 'chat' });
    // Anything the daemon asks for on its own still shows.
    c.applyIntent(nav('a'));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
  });

  it('a navigation to the same workspace without the request id is never swallowed', () => {
    const c = new ClientStore(new Store(initialState('room')));
    c.openAhead('a', 'chat');
    away(c);
    // The core navigating there on its own (a new worktree, a plan step), not the answer.
    c.applyIntent(nav('a', 'chat'));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
  });

  it('a navigation to another tab of that workspace is never swallowed', () => {
    const c = new ClientStore(new Store(initialState('room')));
    const req = c.openAhead('a', 'files');
    // Even carrying the request id: it names another tab, so it isn't the answer.
    c.applyIntent(nav('a', 'chat', req));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
    c.applyIntent(nav('a', 'review'));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'review' });
  });

  it('an open the daemon never answered stops waiting after 10 s', () => {
    vi.useFakeTimers();
    const c = new ClientStore(new Store(initialState('room')));
    const req = c.openAhead('a', 'chat');
    away(c);
    vi.advanceTimersByTime(10_001);
    // No openAhead in between: answered() itself sees it is too old.
    c.applyIntent(nav('a', 'chat', req));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
  });

  it('an unanswered open never blocks later navigations to that workspace', () => {
    const c = new ClientStore(new Store(initialState('room')));
    c.openAhead('a', 'chat');
    for (const tab of ['chat', 'files', 'chat'] as const) {
      away(c);
      c.applyIntent(nav('a', tab));
      expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab });
    }
  });

  it('two quick opens of one workspace drop both answers, then show the next', () => {
    const c = new ClientStore(new Store(initialState('room')));
    const first = c.openAhead('a', 'chat');
    const second = c.openAhead('a', 'files');
    c.applyIntent(nav('a', 'chat', first));
    c.applyIntent(nav('a', 'files', second));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'files' });
    c.applyIntent(nav('a', 'chat'));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
  });

  it('an answer is dropped once: the same request again shows', () => {
    const c = new ClientStore(new Store(initialState('room')));
    const req = c.openAhead('a', 'chat');
    c.applyIntent(nav('a', 'chat', req));
    away(c);
    c.applyIntent(nav('a', 'chat', req));
    expect(view(c)).toEqual({ kind: 'workspace', id: 'a', tab: 'chat' });
  });
});
