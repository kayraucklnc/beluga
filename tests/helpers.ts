export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

import { ClientStore } from '../src/client/client-store.js';
import type { Intent } from '../src/core/intents.js';
import type { Session } from '../src/core/session.js';
import type { AppState, DomainState, Store } from '../src/core/store.js';
import { compose, initialScreen } from '../src/client/screen.js';
import { InProcessClient } from '../src/ipc/in-process.js';

/** A screen over a bare store (for tests that drive core parts directly): intents show in it. */
export function screenOver(store: Store): { screen: ClientStore; intend: (intent: Intent) => void } {
  const screen = new ClientStore(store);
  return { screen, intend: (intent) => screen.applyIntent(intent) };
}

/** What a screen showing the room would draw for this domain state (for UI models in core tests). */
export const appOf = (domain: DomainState): AppState => compose(domain, initialScreen);

/** A screen attached to a session, the way the terminal UI attaches (view, tabs and toasts live here). */
export const attach = (session: Session): InProcessClient => new InProcessClient(session, { kind: 'test' });
