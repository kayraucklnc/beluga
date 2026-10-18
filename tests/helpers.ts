export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

import { intentAction, type Intent } from '../src/core/intents.js';
import type { Store } from '../src/core/store.js';

/** Show intents in the store, the way the terminal UI does (for tests that drive core parts directly). */
export const showIntents = (store: Store) => (intent: Intent): void => {
  const action = intentAction(intent, store.getState().view);
  if (action) store.dispatch(action);
};
