import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialEarnings, reduceEarnings } from '../src/core/earnings-store.js';
import { Store, initialState } from '../src/core/store.js';
import type { Session } from '../src/core/session.js';
import { type Charge, type FetchLike, type Refund, StripeError, catchUp, chargeNet, fullCount } from '../src/core/stripe-client.js';
import { demoStripe } from '../src/core/stripe-demo.js';
import { FULL_RECOUNT_MS, STALE_MS, StripeEarnings, attachEarnings, earningsOf, loadStripeFile } from '../src/core/stripe-earnings.js';
import { stripeKeyKind, stripeKeyProblem } from '../src/shared/stripe-keys.js';
import { HANDLERS } from '../src/ipc/handlers.js';
import { parseArgs } from '../src/ipc/api.js';

const KEY = ['rk', 'live', '51TestKeyAbcdefghijklmnop'].join('_');
const SECRET = ['sk', 'test', '51TestKeyAbcdefghijklmnop'].join('_');

/** A pretend Stripe over plain arrays: newest first, pages, created[gte], and scripted failures. */
class FakeStripe {
  charges: Charge[] = [];
  refunds: Refund[] = [];
  account: unknown = { settings: { dashboard: { display_name: 'Acme Inc.' } } };
  readonly requests: string[] = [];
  /** Status codes to answer next, in order (then normal answers again). */
  fail: number[] = [];
  offline = false;
  private seq = 0;

  charge(created: number, amount: number, extra: Partial<Charge> = {}): Charge {
    const c: Charge = { id: `ch_${++this.seq}`, created, currency: 'usd', status: 'succeeded', paid: true, captured: true, amount, amount_captured: amount, amount_refunded: 0, ...extra };
    this.charges = [c, ...this.charges].sort((a, b) => b.created - a.created);
    return c;
  }

  refund(charge: Charge, created: number, amount: number, extra: Partial<Refund> = {}): Refund {
    const r: Refund = { id: `re_${++this.seq}`, created, currency: charge.currency, amount, status: 'succeeded', charge: charge.id, ...extra };
    this.refunds = [r, ...this.refunds].sort((a, b) => b.created - a.created);
    if (r.status !== 'failed') this.charges = this.charges.map((c) => (c.id === charge.id ? { ...c, amount_refunded: (c.amount_refunded ?? 0) + amount } : c));
    return r;
  }

  fetch: FetchLike = async (url, init) => {
    this.requests.push(url);
    if (this.offline) throw new TypeError('fetch failed');
    expect(init.headers.Authorization).toMatch(/^Bearer (rk|sk)_/);
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, json: async () => body });
    const failing = this.fail.shift();
    if (failing) return reply(failing, { error: { type: 'api_error', message: `nope, key ${KEY.slice(0, 12)}…` } }, failing === 429 ? { 'retry-after': '2' } : {});
    const u = new URL(url);
    if (u.pathname === '/v1/account') return reply(200, this.account);
    const list = u.pathname === '/v1/charges' ? this.charges : u.pathname === '/v1/refunds' ? this.refunds : undefined;
    if (!list) return reply(404, { error: { message: 'no such route' } });
    const limit = Number(u.searchParams.get('limit'));
    const since = Number(u.searchParams.get('created[gte]') ?? 0);
    const after = u.searchParams.get('starting_after');
    const all = (list as ReadonlyArray<{ id: string; created: number }>).filter((x) => x.created >= since);
    const from = after ? all.findIndex((x) => x.id === after) + 1 : 0;
    return reply(200, { object: 'list', data: all.slice(from, from + limit), has_more: from + limit < all.length });
  };
}

const noWait = { sleep: async () => undefined };

describe('what counts as earned', () => {
  it('is what a successful charge captured, minus what was refunded', () => {
    const base = { id: 'ch', created: 1, currency: 'usd', amount: 1000 };
    expect(chargeNet({ ...base, status: 'succeeded', amount_captured: 1000, amount_refunded: 250 })).toBe(750);
    expect(chargeNet({ ...base, status: 'failed', amount_captured: 0 })).toBe(0);
    expect(chargeNet({ ...base, status: 'pending' })).toBe(0);
    expect(chargeNet({ ...base, status: 'succeeded', captured: false, amount_captured: 0 })).toBe(0);
    // Older API versions without amount_captured.
    expect(chargeNet({ ...base, status: 'succeeded', captured: true })).toBe(1000);
    expect(chargeNet({ ...base, status: 'succeeded', amount_captured: 1000, amount_refunded: 1000 })).toBe(0);
  });

  it('checks pasted keys before asking Stripe', () => {
    expect(stripeKeyProblem(KEY)).toBeUndefined();
    expect(stripeKeyProblem(SECRET)).toBeUndefined();
    expect(stripeKeyProblem('')).toMatch(/Paste/);
    expect(stripeKeyProblem('pk_live_51abcdefghijklmnopqrstu')).toMatch(/publishable/);
    expect(stripeKeyProblem('whsec_abcdefghijklmnopqrstu')).toMatch(/webhook/);
    expect(stripeKeyProblem('rk_live_short')).toMatch(/doesn’t look like/);
    expect(stripeKeyKind(KEY)).toEqual({ mode: 'live', secret: false });
    expect(stripeKeyKind(SECRET)).toEqual({ mode: 'test', secret: true });
    expect(stripeKeyKind('nope')).toEqual({ secret: false });
  });
});

describe('counting a Stripe account', () => {
  it('pages through every charge 100 at a time, per currency', async () => {
    const stripe = new FakeStripe();
    for (let i = 0; i < 230; i++) stripe.charge(1000 + i, 100);
    stripe.charge(2000, 500, { currency: 'eur' });
    stripe.charge(2001, 900, { status: 'failed', amount_captured: 0, paid: false });
    const refunded = stripe.charge(2002, 1000);
    stripe.refund(refunded, 2003, 400);
    const tally = await fullCount(KEY, { fetch: stripe.fetch, now: () => 5_000_000 });
    expect(tally.totals).toEqual({ usd: 230 * 100 + 600, eur: 500 });
    expect(tally.newest).toEqual({ created: 2002, ids: [refunded.id] });
    expect(tally.syncedAt).toBe(5000);
    expect(stripe.requests).toHaveLength(3);
    expect(stripe.requests.every((u) => new URL(u).searchParams.get('limit') === '100')).toBe(true);
    expect(new URL(stripe.requests[1]!).searchParams.get('starting_after')).toBeTruthy();
  });

  it('catches up with only new charges, and takes off new refunds on old ones', async () => {
    const stripe = new FakeStripe();
    const old = stripe.charge(1000, 5000);
    stripe.charge(1500, 2000, { id: 'ch_edge_a' });
    stripe.charge(1500, 3000, { id: 'ch_edge_b' });
    const first = await fullCount(KEY, { fetch: stripe.fetch, now: () => 1_600_000 });
    expect(first.totals).toEqual({ usd: 10_000 });
    expect([...(first.newest?.ids ?? [])].sort()).toEqual(['ch_edge_a', 'ch_edge_b']);

    // Later: one more at the edge second, a new one, a refund on an old charge, a refunded new charge, a failed refund.
    stripe.charge(1500, 700, { id: 'ch_edge_c' });
    const fresh = stripe.charge(1700, 4000, { currency: 'gbp' });
    stripe.refund(old, 1650, 1500);
    stripe.refund(fresh, 1750, 1000);
    stripe.refund(old, 1660, 999, { status: 'failed' });
    stripe.requests.length = 0;
    const second = await catchUp(KEY, first, { fetch: stripe.fetch, now: () => 1_800_000 });
    expect(second.totals).toEqual({ usd: 10_000 + 700 - 1500, gbp: 3000 });
    expect(second.newest).toEqual({ created: 1700, ids: [fresh.id] });
    expect(new URL(stripe.requests[0]!).searchParams.get('created[gte]')).toBe('1500');
    expect(stripe.requests.some((u) => u.includes('/v1/refunds') && new URL(u).searchParams.get('created[gte]') === '1600')).toBe(true);

    // Nothing new: the same totals, and a refund seen in the overlap isn't taken off twice.
    stripe.refund(old, 1800, 100);
    const third = await catchUp(KEY, second, { fetch: stripe.fetch, now: () => 1_800_500 });
    expect(third.totals.usd).toBe(10_000 + 700 - 1500 - 100);
    expect(third.seenRefunds).toHaveLength(1);
    const fourth = await catchUp(KEY, third, { fetch: stripe.fetch, now: () => 1_801_000 });
    expect(fourth.totals).toEqual(third.totals);
  });

  it('waits and retries when Stripe says slow down, then gives up clearly', async () => {
    const stripe = new FakeStripe();
    stripe.charge(1, 100);
    const waits: number[] = [];
    stripe.fail = [429, 503];
    const tally = await fullCount(KEY, { fetch: stripe.fetch, sleep: async (ms) => void waits.push(ms) });
    expect(tally.totals).toEqual({ usd: 100 });
    expect(waits).toEqual([2000, 2000]);
    stripe.fail = [429, 429, 429];
    await expect(fullCount(KEY, { fetch: stripe.fetch, maxRetries: 2, ...noWait })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('names what went wrong in its own words', async () => {
    const stripe = new FakeStripe();
    const codeOf = async (): Promise<string> => fullCount(KEY, { fetch: stripe.fetch, maxRetries: 0, ...noWait }).then(() => 'ok', (e: StripeError) => e.code);
    stripe.fail = [401];
    expect(await codeOf()).toBe('revoked');
    stripe.fail = [403];
    expect(await codeOf()).toBe('permission');
    stripe.fail = [500];
    expect(await codeOf()).toBe('stripe');
    stripe.offline = true;
    expect(await codeOf()).toBe('offline');
    stripe.offline = false;
    stripe.fail = [401];
    const err = await fullCount(KEY, { fetch: stripe.fetch, ...noWait }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('rk_live');
  });
});

describe('the earnings service', () => {
  const setup = (opts: { now?: () => number; file?: string | null } = {}) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-stripe-'));
    const file = opts.file === null ? null : (opts.file ?? path.join(dir, 'stripe.json'));
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'shop', root: '/code/shop', base: 'main', workspaces: [] }] });
    const stripe = new FakeStripe();
    const service = new StripeEarnings({ store, file, stripe: { fetch: stripe.fetch, ...noWait }, ...(opts.now ? { now: opts.now } : {}) });
    return { store, stripe, service, file };
  };

  it('connects a key, counts in the background, and never lets the key out', async () => {
    const { store, stripe, service, file } = setup();
    stripe.charge(100, 2500);
    stripe.charge(200, 1000, { currency: 'eur' });
    const result = await service.connect('p1', `  ${KEY}\n`);
    expect(result).toEqual({ account: 'Acme Inc.', mode: 'live', secretKey: false });
    expect(store.getState().earnings['/code/shop']).toMatchObject({ connected: true, account: 'Acme Inc.', refreshing: true });
    await service.settled();
    const shown = store.getState().earnings['/code/shop']!;
    expect(shown.totals).toEqual([
      { currency: 'usd', amount: 2500 },
      { currency: 'eur', amount: 1000 },
    ]);
    expect(shown.refreshing).toBeUndefined();
    expect(shown.updatedAt).toBeGreaterThan(0);
    expect(JSON.stringify(store.getState())).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    // Kept only in the file, readable only by you.
    expect(loadStripeFile(file!).projects['/code/shop']?.key).toBe(KEY);
    expect(statSync(file!).mode & 0o777).toBe(0o600);
    // A new service (Beluga restarting) shows the same, without asking Stripe.
    const store2 = new Store(initialState('room'));
    const again = new StripeEarnings({ store: store2, file: file!, stripe: { fetch: stripe.fetch } });
    expect(store2.getState().earnings['/code/shop']?.totals).toEqual(shown.totals);
    again.stop();
  });

  it('says why a key is refused, and keeps nothing', async () => {
    const { store, stripe, service, file } = setup();
    await expect(service.connect('p1', 'pk_live_51abcdefghijklmnopqrstu')).rejects.toThrow(/publishable/);
    stripe.fail = [403];
    await expect(service.connect('p1', KEY)).rejects.toThrow('This key can’t read charges. Edit it in Stripe and set Charges to Read.');
    stripe.fail = [401];
    await expect(service.connect('p1', KEY)).rejects.toThrow(/doesn’t know this key/);
    await expect(service.connect('nope', KEY)).rejects.toThrow(/gone/);
    expect(store.getState().earnings).toEqual({});
    expect(loadStripeFile(file!).projects).toEqual({});
  });

  it('works without the account name, and flags a full secret key', async () => {
    const { store, stripe, service } = setup();
    stripe.account = undefined;
    stripe.fail = [];
    const original = stripe.fetch;
    stripe.fetch = async (url, init) => (url.includes('/v1/account') ? { status: 403, headers: { get: () => null }, json: async () => ({}) } : original(url, init));
    const service2 = new StripeEarnings({ store, file: null, stripe: { fetch: stripe.fetch, ...noWait } });
    const result = await service2.connect('p1', SECRET);
    expect(result).toEqual({ mode: 'test', secretKey: true });
    await service2.settled();
    expect(store.getState().earnings['/code/shop']).toMatchObject({ connected: true, mode: 'test', secretKey: true, totals: [] });
    expect(store.getState().earnings['/code/shop']?.account).toBeUndefined();
    service.stop();
  });

  it('refreshes incrementally, keeps the last total when offline, and stops trying a revoked key', async () => {
    let now = 1_000_000_000;
    const { store, stripe, service } = setup({ now: () => now });
    stripe.charge(100, 1000);
    await service.connect('p1', KEY);
    await service.settled();
    stripe.charge(999_000, 500);
    stripe.requests.length = 0;
    now += 60_000;
    await service.refresh('p1');
    expect(stripe.requests.some((u) => u.includes('created%5Bgte%5D') || u.includes('created[gte]'))).toBe(true);
    expect(store.getState().earnings['/code/shop']?.totals).toEqual([{ currency: 'usd', amount: 1500 }]);

    stripe.offline = true;
    now += 60_000;
    await service.refresh();
    const offline = store.getState().earnings['/code/shop']!;
    expect(offline.totals).toEqual([{ currency: 'usd', amount: 1500 }]);
    expect(offline.error).toMatchObject({ code: 'offline' });
    stripe.offline = false;

    // A day later the background check refreshes it; within the day it doesn't.
    stripe.requests.length = 0;
    await service.refreshIfStale();
    expect(stripe.requests).toEqual([]);
    now += STALE_MS + 1;
    await service.refreshIfStale();
    expect(stripe.requests.length).toBeGreaterThan(0);
    expect(store.getState().earnings['/code/shop']?.error).toBeUndefined();

    stripe.fail = [401];
    now += STALE_MS + 1;
    await service.refreshIfStale();
    expect(store.getState().earnings['/code/shop']?.error).toMatchObject({ code: 'revoked', message: expect.stringMatching(/revoked/) });
    stripe.requests.length = 0;
    now += STALE_MS + 1;
    await service.refreshIfStale();
    expect(stripe.requests).toEqual([]);
  });

  it('counts everything again once a week to correct drift', async () => {
    let now = 2_000_000_000;
    const { store, stripe, service } = setup({ now: () => now });
    const c = stripe.charge(100, 1000);
    await service.connect('p1', KEY);
    await service.settled();
    // A change the quick look can't see (an old charge captured later).
    stripe.charges = stripe.charges.map((x) => (x.id === c.id ? { ...x, amount_captured: 1000, amount: 3000 } : x));
    stripe.charge(150, 2000);
    now += FULL_RECOUNT_MS + 1;
    stripe.requests.length = 0;
    await service.refresh('p1');
    expect(stripe.requests.some((u) => u.includes('created'))).toBe(false);
    expect(store.getState().earnings['/code/shop']?.totals).toEqual([{ currency: 'usd', amount: 3000 }]);
  });

  it('forgets the key and the totals on disconnect, even mid-count', async () => {
    const { store, stripe, service, file } = setup();
    for (let i = 0; i < 300; i++) stripe.charge(i + 1, 100);
    await service.connect('p1', KEY);
    service.disconnect('p1');
    await service.settled();
    expect(store.getState().earnings).toEqual({});
    expect(loadStripeFile(file!).projects).toEqual({});
    expect(readFileSync(file!, 'utf8')).not.toContain(KEY);
  });

  it('answers the stripe.* API without ever returning the key', async () => {
    const { store, stripe, service } = setup();
    stripe.charge(1, 4200);
    const session = { store } as unknown as Session;
    expect(() => earningsOf(session)).toThrow(/Beluga app for Mac/);
    await expect(HANDLERS['stripe.connect'](session, 'p1', KEY)).rejects.toThrow(/Beluga app for Mac/);
    attachEarnings(session, service);
    const refused = await HANDLERS['stripe.connect'](session, ...parseArgs('stripe.connect', ['p1', 'pk_live_51abcdefghijklmnopqrstu']));
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/publishable/) });
    const args = parseArgs('stripe.connect', ['p1', KEY]);
    const result = await HANDLERS['stripe.connect'](session, ...args);
    expect(result).toEqual({ ok: true, account: 'Acme Inc.', mode: 'live', secretKey: false });
    expect(JSON.stringify(result)).not.toContain(KEY);
    await HANDLERS['stripe.refresh'](session, ...parseArgs('stripe.refresh', []));
    await service.settled();
    expect(store.getState().earnings['/code/shop']?.totals).toEqual([{ currency: 'usd', amount: 4200 }]);
    HANDLERS['stripe.disconnect'](session, ...parseArgs('stripe.disconnect', ['p1']));
    expect(store.getState().earnings).toEqual({});
    expect(() => parseArgs('stripe.connect', ['p1', ''])).toThrow();
  });
});

describe('the demo’s pretend Stripe', () => {
  it('earns something for a valid key and refuses the others', async () => {
    const store = new Store(initialState('room'));
    store.dispatch({ type: 'projects', projects: [{ id: 'p1', name: 'shop', root: '/code/shop', base: 'main', workspaces: [] }] });
    const service = new StripeEarnings({ store, file: null, stripe: { fetch: demoStripe(() => 1_700_000_000_000), ...noWait } });
    await expect(service.connect('p1', ['rk', 'test', 'revokedKey000000000000'].join('_'))).rejects.toThrow(/doesn’t know/);
    await expect(service.connect('p1', ['rk', 'test', 'nochargesKey0000000000'].join('_'))).rejects.toThrow(/Charges to Read/);
    expect(await service.connect('p1', ['rk', 'live', 'demoBobApi00000000000000'].join('_'))).toEqual({ account: 'Bob API, Inc.', mode: 'live', secretKey: false });
    await service.settled();
    const totals = store.getState().earnings['/code/shop']?.totals ?? [];
    expect(totals.map((t) => t.currency)).toEqual(['usd', 'eur']);
    const before = totals[0]!.amount;
    await service.refresh('p1');
    expect(store.getState().earnings['/code/shop']?.totals?.[0]?.amount).toBe(before);
  });
});

describe('the earnings slice', () => {
  it('adds, replaces and removes a project’s earnings', () => {
    const one = reduceEarnings(initialEarnings, { type: 'earnings', root: '/a', earnings: { connected: true, mode: 'live' } });
    expect(one.earnings['/a']).toEqual({ connected: true, mode: 'live' });
    const gone = reduceEarnings(one, { type: 'earnings', root: '/a' });
    expect(gone.earnings).toEqual({});
    expect(reduceEarnings(gone, { type: 'earnings', root: '/a' })).toBe(gone);
  });
});
