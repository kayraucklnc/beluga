import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allNeeds, needsYou, waitingNeeds } from '../src/companion/needs-you.js';
import { loadDismissedNeeds, saveDismissedNeeds, withDismissed } from '../src/core/dismissed-needs.js';
import { Store, initialState } from '../src/core/store.js';

/** Dismiss on a needs-you item (BLG-359): off every list without answering it, and remembered. */
describe('dismissing what needs you', () => {
  const store = (): Store => {
    const s = new Store(initialState('room'));
    s.dispatch({ type: 'approval_add', approval: { id: 'ap1', kind: 'tool', title: 'Run rm -rf dist?', detail: 'Bash rm -rf dist', askedAt: 1, timeoutMs: 60_000, channel: 'ws:w1' } });
    s.dispatch({ type: 'approval_add', approval: { id: 'ap2', kind: 'tool', title: 'Deploy?', detail: 'wrangler deploy', askedAt: 2, timeoutMs: 60_000, channel: 'ws:w1' } });
    return s;
  };

  it('leaves the lists the phone and the Mac read, and only those', () => {
    const s = store();
    const ids = needsYou(s.getState()).map((n) => n.id);
    expect(ids.length).toBe(2);
    s.dispatch({ type: 'needs_dismissed', ids: [ids[0]!] });
    expect(allNeeds(s.getState()).map((n) => n.id)).toEqual([ids[1]]);
    expect(needsYou(s.getState()).map((n) => n.id)).toEqual([ids[1]]);
    // Still waiting underneath: answering it later works as before.
    expect(waitingNeeds(s.getState()).length).toBe(2);
  });

  it('keeps only what is still waiting, and survives a restart', () => {
    expect(withDismissed(['gone', 'a'], 'b', new Set(['a', 'b']))).toEqual(['a', 'b']);
    expect(withDismissed(['a'], 'a', new Set(['a']))).toEqual(['a']);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-dismissed-')), 'dismissed-needs.json');
    expect(loadDismissedNeeds(file)).toEqual([]);
    saveDismissedNeeds(['a', 'b'], file);
    expect(loadDismissedNeeds(file)).toEqual(['a', 'b']);
  });
});
