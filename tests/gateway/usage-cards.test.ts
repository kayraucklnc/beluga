import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharesUsageWith } from '../../src/core/gateway/access.js';
import type { ProviderUsage } from '../../src/protocol.js';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { node } from './helpers.js';

/** A friend's plan usage on their profile (BLG-597): it rides on their card, only to those they share it with. */

describe('who sees your usage', () => {
  it('people you trust by default; every friend or no one when you say so; never anyone blocked', () => {
    expect(['blocked', 'ask', 'trusted', 'full'].map((t) => sharesUsageWith('trusted', t))).toEqual([false, false, true, true]);
    expect(['blocked', 'ask', 'trusted', 'full'].map((t) => sharesUsageWith('everyone', t))).toEqual([false, true, true, true]);
    expect(['blocked', 'ask', 'trusted', 'full'].map((t) => sharesUsageWith('off', t))).toEqual([false, false, false, false]);
  });
});

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

const USAGES: ProviderUsage[] = [
  { agent: { runtime: 'claude', label: 'Claude' }, plan: 'max', fiveHour: { pct: 34, resetsAt: 1_900_000_000_000 }, week: { pct: 61 }, updatedAt: 1 },
  { agent: { runtime: 'codex', label: 'Codex' }, fiveHour: { pct: 12 }, updatedAt: 1 },
];

describe('usage on a friend’s card', () => {
  it('arrives once they trust you, and stops when they turn it off', async () => {
    const pam = await node(net, 'pam');
    const quinn = await node(net, 'quinn');
    await befriend(pam.person, quinn.person);
    quinn.store.dispatch({ type: 'welcome', self: { peerId: quinn.id, name: 'quinn', shares: [], agent: true, usages: USAGES } });
    const card = () => pam.store.getState().gateway.cards[quinn.id];

    // "Ask me each time": their card comes, without their usage.
    quinn.trust(pam.id, 'ask');
    await settle(() => card() !== undefined);
    expect(card()?.usages).toBeUndefined();

    // Trusted: Claude's and Codex's, as their Mac has them.
    quinn.trust(pam.id, 'trusted');
    await settle(() => card()?.usages?.length === 2);
    expect(card()?.usages?.map((u) => [u.agent.runtime, u.fiveHour?.pct])).toEqual([['claude', 34], ['codex', 12]]);

    // No one: the next card takes it away.
    quinn.store.dispatch({ type: 'prefs', prefs: { shareUsage: 'off' } });
    await settle(() => card()?.usages === undefined);
  }, 60_000);
});
