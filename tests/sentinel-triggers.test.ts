import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sentinel, Trigger, UptimeTrigger } from '../src/core/sentinel/model.js';
import { belugaEvent } from '../src/core/sentinel/triggers/beluga.js';
import { ghTrouble, lookGitHub, startGitHub, type GitHubCursor } from '../src/core/sentinel/triggers/github.js';
import { Triggers } from '../src/core/sentinel/triggers/index.js';
import { NO_SENTRY_TOKEN, type SentryCursor, fetchSentry, parseSentryIssues, sentryStep, startSentry } from '../src/core/sentinel/triggers/sentry.js';
import { NO_STRIPE, type StripeCursor, lookStripe, moneyText, startStripe } from '../src/core/sentinel/triggers/stripe.js';
import { type FetchLike, MAX_BACKOFF_MS, TROUBLE_MS, type TriggerDeps, type TriggerEvent, startPolling } from '../src/core/sentinel/triggers/types.js';
import { checkUrl, uptimeStep, type UptimeCursor } from '../src/core/sentinel/triggers/uptime.js';
import { MAX_BODY, PER_MINUTE, WebhookHub, githubSignatureOk, newSecret, sameSecret, stripeSignatureOk } from '../src/core/sentinel/triggers/webhook.js';
import { Sentinels } from '../src/core/sentinel/sentinels.js';
import type { GitHubRepo } from '../src/workspaces/github.js';
import { project, setup, until } from './sentinel-fakes.js';
import { Store, initialState } from '../src/core/store.js';

/** Sentinel's event triggers (docs/sentinel.md §1, phase 3): the pollers, the listener, the webhook server, and their coordinator. */

const MIN = 60_000;
const repo: GitHubRepo = { host: 'github.com', owner: 'acme', repo: 'bob-api', url: 'https://github.com/acme/bob-api' };
const iso = (ms: number): string => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-26T09:00:00Z');

const sentinel = (trigger: Trigger, over: Partial<Sentinel> = {}): Sentinel => ({ id: 'sn_1', name: 'Watcher', icon: 'eye', projectId: 'api', trigger, steps: [], access: 'look', limits: { minutes: 30, pauseAfter: 3 }, notify: 'mac', paused: false, failures: 0, createdAt: 0, updatedAt: 0, ...over });

/** A context that keeps what the trigger says. */
function context<C>(s: Sentinel, start?: C) {
  let cursor = start;
  const fired: TriggerEvent[] = [];
  const troubles: Array<string | undefined> = [];
  return {
    ctx: { sentinel: s, cursor: () => cursor, save: (c: C) => void (cursor = c), fire: (e: TriggerEvent) => void fired.push(e), trouble: (w: string | undefined) => void troubles.push(w) },
    fired,
    troubles,
    cursor: () => cursor,
  };
}

/** A JSON fetch answering by URL. */
const jsonFetch =
  (answer: (url: string) => { status?: number; body: unknown } | Error, calls: string[] = []): FetchLike =>
  async (url) => {
    calls.push(url);
    const a = answer(url);
    if (a instanceof Error) throw a;
    return { status: a.status ?? 200, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };

describe('the polling loop', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('looks every few minutes, waits twice as long after each error (up to 30 minutes), and is back on time after a good look', async () => {
    const at: number[] = [];
    const script = ['ok', 'err', 'err', 'err', 'err', 'err', 'err', 'ok', 'ok'];
    let n = 0;
    const troubles: Array<string | undefined> = [];
    const stop = startPolling(
      { trouble: (w) => void troubles.push(w) },
      async () => {
        at.push(Date.now());
        if (script[n++] === 'err') throw new Error('HTTP 502 from GitHub');
        return undefined;
      },
      { everyMs: 2 * MIN, failing: 'GitHub didn’t answer' },
    );
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
    stop();
    const gaps = at.map((t, i) => (i ? (t - at[i - 1]!) / MIN : (t - start) / MIN));
    // At once, then 2 min; errors: 4, 8, 16, 30, 30, 30; a good look: back to 2.
    expect(gaps.slice(0, 9)).toEqual([0, 2, 4, 8, 16, 30, 30, 30, 2]);
    expect(Math.max(...gaps)).toBe(MAX_BACKOFF_MS / MIN);
    // Three errors in a row say so on the page; the good look clears it.
    expect(troubles.find(Boolean)).toMatch(/^GitHub didn’t answer: HTTP 502 from GitHub\. It tries again in \d+ minutes\.$/);
    expect(troubles.at(-1)).toBeUndefined();
  });

  it('with trouble, says so and sleeps 10 minutes; stopped, it never looks again', async () => {
    let looks = 0;
    const troubles: Array<string | undefined> = [];
    const stop = startPolling({ trouble: (w) => void troubles.push(w) }, async () => (++looks, 'Sign in to GitHub first'), { everyMs: MIN });
    await vi.advanceTimersByTimeAsync(TROUBLE_MS * 2 + 1);
    expect(looks).toBe(3);
    expect(troubles).toEqual(['Sign in to GitHub first', 'Sign in to GitHub first', 'Sign in to GitHub first']);
    stop();
    await vi.advanceTimersByTimeAsync(TROUBLE_MS * 3);
    expect(looks).toBe(3);
  });
});

describe('GitHub', () => {
  /** gh answering `gh api <path>` from a table of paths (by prefix). */
  const fakeGh = (table: Record<string, unknown>, calls: string[][] = []) => async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    const p = args[args.length - 1]!;
    const key = Object.keys(table).find((k) => p.startsWith(k));
    if (!key) throw new Error(`gh: no fake for ${p}`);
    const v = table[key];
    if (v instanceof Error) throw v;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };
  const run = (id: number, at: number, name = 'CI') => ({ id, name, head_branch: 'main', head_sha: 'abc123', run_number: id, html_url: `https://github.com/acme/bob-api/actions/runs/${id}`, event: 'push', actor: { login: 'lena' }, created_at: iso(at - MIN), updated_at: iso(at) });

  it('a failed workflow: the first look notes what’s there, a new failure fires once with its jobs, step and log tail', async () => {
    const t = { kind: 'github' as const, what: 'workflow-failed' as const };
    const runs = { workflow_runs: [run(1, T0 - 10 * MIN)] };
    const jobs = { jobs: [{ id: 77, name: 'test', conclusion: 'failure', html_url: 'https://github.com/j/77', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'npm test', conclusion: 'failure' }] }, { id: 78, name: 'lint', conclusion: 'success', steps: [] }] };
    const table: Record<string, unknown> = { 'repos/acme/bob-api/actions/runs?': runs, 'repos/acme/bob-api/actions/runs/2/jobs': jobs, 'repos/acme/bob-api/actions/jobs/77/logs': '2026-10-26T09:01:00.0000000Z > vitest run\n2026-10-26T09:01:02.0000000Z FAIL tests/login.test.ts\n2026-10-26T09:01:02.1000000Z Expected 200, got 500\n' };
    const gh = fakeGh(table);
    const first = await lookGitHub(t, repo, undefined, gh, T0);
    expect(first.events).toEqual([]);
    expect(first.cursor).toEqual({ since: T0 - 10 * MIN, seen: ['r1'] });
    // Nothing new: nothing fires, the cursor stays.
    const same = await lookGitHub(t, repo, first.cursor, gh, T0 + 2 * MIN);
    expect(same.events).toEqual([]);
    runs.workflow_runs.unshift(run(2, T0 + 3 * MIN));
    const next = await lookGitHub(t, repo, same.cursor, gh, T0 + 4 * MIN);
    expect(next.events).toHaveLength(1);
    expect(next.events[0]!.summary).toBe('GitHub: workflow CI failed on main: test › npm test');
    expect(next.events[0]!.payload).toMatchObject({ workflow: 'CI', branch: 'main', run: 2, url: 'https://github.com/acme/bob-api/actions/runs/2', failed: [{ job: 'test', step: 'npm test', url: 'https://github.com/j/77' }], log: '> vitest run\nFAIL tests/login.test.ts\nExpected 200, got 500' });
    expect(next.cursor).toEqual({ since: T0 + 3 * MIN, seen: ['r1', 'r2'] });
    // Never twice.
    expect((await lookGitHub(t, repo, next.cursor, gh, T0 + 6 * MIN)).events).toEqual([]);
  });

  it('issues, labels and pull requests: only what’s new, oldest first; pull requests aren’t issues', async () => {
    const issues = [{ number: 3, title: 'Old', created_at: iso(T0 - 60 * MIN), html_url: 'u3', user: { login: 'a' }, labels: [] }];
    const gh = fakeGh({ 'repos/acme/bob-api/issues?': issues });
    const t = { kind: 'github' as const, what: 'issue-opened' as const };
    let c: GitHubCursor = (await lookGitHub(t, repo, undefined, gh, T0)).cursor;
    issues.unshift({ number: 5, title: 'Sign-in fails with a + in the email', created_at: iso(T0 + 2 * MIN), html_url: 'u5', user: { login: 'lena' }, labels: [{ name: 'bug' }] as never }, { number: 4, title: 'Second', created_at: iso(T0 + MIN), html_url: 'u4', user: { login: 'b' }, labels: [] }, { number: 9, title: 'A PR', created_at: iso(T0 + MIN), pull_request: {} } as never);
    const r = await lookGitHub(t, repo, c, gh, T0 + 3 * MIN);
    expect(r.events.map((e) => e.summary)).toEqual(['GitHub: issue #4 opened: Second', 'GitHub: issue #5 opened: Sign-in fails with a + in the email']);
    expect(r.events[1]!.payload).toMatchObject({ number: 5, author: 'lena', labels: ['bug'], url: 'u5' });
    c = r.cursor;
    expect((await lookGitHub(t, repo, c, gh, T0 + 5 * MIN)).events).toEqual([]);

    const events = [{ id: 1, event: 'labeled', label: { name: 'Bug' }, created_at: iso(T0 - MIN), issue: { number: 3, title: 'Old' } }];
    const gl = fakeGh({ 'repos/acme/bob-api/issues/events': events });
    const tl = { kind: 'github' as const, what: 'issue-labelled' as const, label: 'bug' };
    const cl = (await lookGitHub(tl, repo, undefined, gl, T0)).cursor;
    events.unshift({ id: 3, event: 'labeled', label: { name: 'docs' }, created_at: iso(T0 + MIN), issue: { number: 4, title: 'x' } }, { id: 2, event: 'labeled', label: { name: 'bug' }, created_at: iso(T0 + MIN), issue: { number: 4, title: 'Crash on save' } });
    const rl = await lookGitHub(tl, repo, cl, gl, T0 + 2 * MIN);
    expect(rl.events.map((e) => e.summary)).toEqual(['GitHub: issue #4 got the label “bug”: Crash on save']);

    const pulls = [{ number: 1, title: 'Old', created_at: iso(T0 - MIN) }];
    const gp = fakeGh({ 'repos/acme/bob-api/pulls?': pulls });
    const tp = { kind: 'github' as const, what: 'pr-opened' as const };
    const cp = (await lookGitHub(tp, repo, undefined, gp, T0)).cursor;
    pulls.unshift({ number: 2, title: 'Faster checkout', created_at: iso(T0 + MIN), head: { ref: 'fast' }, base: { ref: 'main' }, draft: true } as never);
    const rp = await lookGitHub(tp, repo, cp, gp, T0 + 2 * MIN);
    expect(rp.events[0]).toMatchObject({ summary: 'GitHub: pull request #2 opened: Faster checkout', payload: { branch: 'fast', base: 'main', draft: true } });
  });

  it('a failed deployment fires once per failed status', async () => {
    const statuses: Record<string, unknown> = { 'repos/acme/bob-api/deployments?': [{ id: 10, environment: 'production', ref: 'main', sha: 'abc', updated_at: iso(T0) }], 'repos/acme/bob-api/deployments/10/statuses': [{ id: 100, state: 'success', created_at: iso(T0) }] };
    const gh = fakeGh(statuses);
    const t = { kind: 'github' as const, what: 'deployment-failed' as const };
    const c = (await lookGitHub(t, repo, undefined, gh, T0)).cursor;
    statuses['repos/acme/bob-api/deployments/10/statuses'] = [{ id: 101, state: 'failure', description: 'Health check failed', created_at: iso(T0 + MIN), log_url: 'https://deploys/101' }];
    const r = await lookGitHub(t, repo, c, gh, T0 + 2 * MIN);
    expect(r.events.map((e) => e.summary)).toEqual(['GitHub: the production deployment of main failed']);
    expect(r.events[0]!.payload).toMatchObject({ state: 'failure', description: 'Health check failed', url: 'https://deploys/101' });
    expect((await lookGitHub(t, repo, r.cursor, gh, T0 + 4 * MIN)).events).toEqual([]);
  });

  it('says what gh needs in words, and sleeps on it', async () => {
    expect(ghTrouble(new Error('spawn gh ENOENT'))).toBe('GitHub needs the gh command: brew install gh, then gh auth login');
    expect(ghTrouble(new Error('To get started with GitHub CLI, please run:  gh auth login'))).toBe('Sign in to GitHub first: run gh auth login in a terminal');
    expect(ghTrouble(new Error('HTTP 404: Not Found (https://api.github.com/repos/acme/x)'))).toMatch(/doesn’t show this repository/);
    expect(ghTrouble(new Error('HTTP 502'))).toBeUndefined();
    vi.useFakeTimers();
    try {
      const t = { kind: 'github' as const, what: 'workflow-failed' as const };
      const signedOut = context<GitHubCursor>(sentinel(t));
      const stop = startGitHub(t, signedOut.ctx, { store: new Store(initialState('room')), selfId: () => 'me', gh: async () => Promise.reject(new Error('not logged in to any hosts. gh auth login')), repoOf: async () => repo });
      await vi.advanceTimersByTimeAsync(1);
      expect(signedOut.troubles).toEqual(['Sign in to GitHub first: run gh auth login in a terminal']);
      stop();
      const offGitHub = context<GitHubCursor>(sentinel(t));
      const stop2 = startGitHub(t, offGitHub.ctx, { store: new Store(initialState('room')), selfId: () => 'me', gh: async () => '[]', repoOf: async () => undefined });
      await vi.advanceTimersByTimeAsync(1);
      expect(offGitHub.troubles).toEqual(['This project isn’t on GitHub: its main folder has no GitHub remote']);
      stop2();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Stripe', () => {
  const event = (id: string, created: number, type: string, object: Record<string, unknown>) => ({ id, created, type, livemode: false, data: { object } });

  it('reads only new events of its kinds, sums them up without card details, and never fires twice', async () => {
    const t = { kind: 'stripe' as const, what: 'payment-failed' as const };
    const list: unknown[] = [event('evt_0', 1000, 'invoice.payment_failed', {})];
    const calls: string[] = [];
    const f = jsonFetch(() => ({ body: { data: list, has_more: false } }), calls);
    const first = await lookStripe(t, 'sk_test_x', undefined, f, T0);
    expect(first).toEqual({ events: [], cursor: { at: 1000, seen: ['evt_0'] } });
    expect(decodeURIComponent(calls[0]!)).toContain('types[]=payment_intent.payment_failed&types[]=invoice.payment_failed');
    list.unshift(
      event('evt_2', 1005, 'invoice.payment_failed', { id: 'in_1', amount_due: 1900, currency: 'eur', customer_email: 'max@acme.dev', customer: 'cus_2' }),
      event('evt_1', 1003, 'payment_intent.payment_failed', { id: 'pi_1', amount: 4200, currency: 'usd', receipt_email: 'lena@acme.dev', description: 'Pro plan', last_payment_error: { message: 'Your card was declined.' }, payment_method: { card: { last4: '4242', number: '4242424242424242' } } }),
    );
    const next = await lookStripe(t, 'sk_test_x', first.cursor, f, T0);
    expect(decodeURIComponent(calls[1]!)).toContain('created[gte]=1000');
    expect(next.events.map((e) => e.summary)).toEqual(['Stripe: payment failed, $42.00', 'Stripe: payment failed, €19.00']);
    expect(next.events[0]!.payload).toEqual({ id: 'evt_1', type: 'payment_intent.payment_failed', livemode: false, amount: 4200, currency: 'usd', amountText: '$42.00', email: 'lena@acme.dev', description: 'Pro plan', reason: 'Your card was declined.', object: 'pi_1' });
    expect(JSON.stringify(next.events)).not.toMatch(/4242/);
    expect(next.cursor).toEqual({ at: 1005, seen: ['evt_2'] });
    expect((await lookStripe(t, 'sk_test_x', next.cursor, f, T0)).events).toEqual([]);
    expect(moneyText(500, 'jpy')).toBe('¥500');
  });

  it('without a key, or with one that can’t read events, says what to do', async () => {
    vi.useFakeTimers();
    try {
      const t = { kind: 'stripe' as const, what: 'refund' as const };
      const none = context<StripeCursor>(sentinel(t));
      const stop = startStripe(t, none.ctx, { store: new Store(initialState('room')), selfId: () => 'me', fetch: jsonFetch(() => ({ body: {} })), stripeKey: () => undefined });
      await vi.advanceTimersByTimeAsync(1);
      expect(none.troubles).toEqual([NO_STRIPE]);
      stop();
      const restricted = context<StripeCursor>(sentinel(t));
      const stop2 = startStripe(t, restricted.ctx, { store: new Store(initialState('room')), selfId: () => 'me', fetch: jsonFetch(() => ({ status: 403, body: {} })), stripeKey: () => 'rk_live_x' });
      await vi.advanceTimersByTimeAsync(1);
      expect(restricted.troubles[0]).toMatch(/can’t read events: give it Events: Read/);
      stop2();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('uptime', () => {
  const t: UptimeTrigger = { kind: 'uptime', url: 'https://example.com/health', minutes: 5 };
  const ok = { ok: true, status: 200, ms: 120 };
  const bad = { ok: false, status: 503, ms: 40 };

  it('goes down after two failures in a row, fires once, and says “back” once on the first good answer', () => {
    let c: UptimeCursor | undefined;
    const fired: TriggerEvent[] = [];
    const step = (check: typeof ok, at: number): void => {
      const r = uptimeStep(t, c, check, at);
      c = r.cursor;
      if (r.event) fired.push(r.event);
    };
    step(ok, T0);
    step(bad, T0 + 5 * MIN); // a blip
    step(ok, T0 + 10 * MIN);
    expect(fired).toEqual([]);
    step(bad, T0 + 15 * MIN);
    step(bad, T0 + 20 * MIN);
    step(bad, T0 + 25 * MIN);
    step({ ok: false, status: 0, ms: 10_000, error: 'no answer in 10 s' } as typeof ok, T0 + 30 * MIN);
    expect(fired.map((e) => e.summary)).toEqual(['example.com stopped answering (503)']);
    expect(fired[0]!.payload).toMatchObject({ state: 'down', status: 503, since: T0 + 15 * MIN });
    step(ok, T0 + 35 * MIN);
    step(ok, T0 + 40 * MIN);
    expect(fired.map((e) => e.summary)).toEqual(['example.com stopped answering (503)', 'example.com is back (200, 120 ms)']);
    expect(fired[1]!.payload).toMatchObject({ state: 'up', status: 200, ms: 120, since: T0 + 15 * MIN, downFor: 20 * MIN });
    expect(c).toMatchObject({ state: 'up', fails: 0 });
  });

  it('checks with a 10 s timeout and the status it expects', async () => {
    const seen: Array<{ url: string; redirect?: string }> = [];
    const f: FetchLike = async (url, init) => (seen.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) }), { status: 204, text: async () => '' });
    expect(await checkUrl(f, { ...t, expect: 204 })).toMatchObject({ ok: true, status: 204 });
    expect(await checkUrl(f, t)).toMatchObject({ ok: false, status: 204 });
    expect(await checkUrl(f, { ...t, expect: 301 })).toMatchObject({ ok: false });
    expect(seen.map((x) => x.redirect)).toEqual(['follow', 'follow', 'manual']);
    const timeout: FetchLike = async () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect(await checkUrl(timeout, t)).toMatchObject({ ok: false, status: 0, error: 'no answer in 10 s' });
  });
});

describe('Sentry', () => {
  const issue = (id: string, over: Record<string, unknown> = {}) => ({ id, title: 'TypeError: cart is undefined', culprit: 'checkout', count: '3', permalink: `https://sentry.io/i/${id}`, firstSeen: iso(T0 - 60 * MIN), lastSeen: iso(T0), status: 'unresolved', ...over });
  const parse = (xs: unknown[]) => parseSentryIssues(xs);

  it('a new issue: first seen after the cursor, once', () => {
    const t = { kind: 'sentry' as const, org: 'acme', project: 'web', what: 'new-issue' as const };
    const a = sentryStep(t, parse([issue('1')]), undefined, T0);
    expect(a.events).toEqual([]);
    const b = sentryStep(t, parse([issue('2', { firstSeen: iso(T0 + MIN), title: 'RangeError: bad date', culprit: 'invoice.ts' }), issue('1')]), a.cursor, T0 + 2 * MIN);
    expect(b.events.map((e) => e.summary)).toEqual(['Sentry: RangeError in invoice.ts']);
    expect(b.events[0]!.payload).toMatchObject({ id: '2', count: 3, permalink: 'https://sentry.io/i/2', project: 'acme/web' });
    expect(sentryStep(t, parse([issue('2', { firstSeen: iso(T0 + MIN) }), issue('1')]), b.cursor, T0 + 4 * MIN).events).toEqual([]);
  });

  it('a regression fires once while it lasts, and again if it comes back', () => {
    const t = { kind: 'sentry' as const, org: 'acme', project: 'web', what: 'regression' as const };
    let c = sentryStep(t, parse([issue('1')]), undefined, T0).cursor;
    const r1 = sentryStep(t, parse([issue('1', { substatus: 'regressed' })]), c, T0 + MIN);
    expect(r1.events.map((e) => e.summary)).toEqual(['Sentry regression: TypeError in checkout']);
    c = sentryStep(t, parse([issue('1', { substatus: 'regressed' })]), r1.cursor, T0 + 2 * MIN).cursor;
    c = sentryStep(t, parse([issue('1', { substatus: 'ongoing' })]), c, T0 + 3 * MIN).cursor;
    expect(sentryStep(t, parse([issue('1', { substatus: 'regressed' })]), c, T0 + 4 * MIN).events).toHaveLength(1);
  });

  it('a spike: escalating, or at least 10 events this hour and more than 5 times the hour before', () => {
    const t = { kind: 'sentry' as const, org: 'acme', project: 'web', what: 'spike' as const };
    let c = sentryStep(t, parse([issue('1', { count: '100' })]), undefined, T0).cursor;
    // The first hour: 4 more (the hour before's growth is known after it).
    c = sentryStep(t, parse([issue('1', { count: '104' })]), c, T0 + 61 * MIN).cursor;
    expect(c.hours['1']).toEqual({ count: 104, at: T0 + 61 * MIN, before: 4 });
    // 15 more than 5 × 4 = 20? No: 19 isn't a spike.
    const calm = sentryStep(t, parse([issue('1', { count: '123' })]), c, T0 + 80 * MIN);
    expect(calm.events).toEqual([]);
    const spike = sentryStep(t, parse([issue('1', { count: '130' })]), calm.cursor, T0 + 90 * MIN);
    expect(spike.events.map((e) => e.summary)).toEqual(['Sentry spike: TypeError in checkout']);
    expect(spike.events[0]!.payload).toMatchObject({ lastHour: 26, hourBefore: 4 });
    // Once while it lasts.
    expect(sentryStep(t, parse([issue('1', { count: '140' })]), spike.cursor, T0 + 95 * MIN).events).toEqual([]);
    // Sentry's own word counts at once.
    expect(sentryStep(t, parse([issue('2', { substatus: 'escalating' })]), c, T0 + 70 * MIN).events).toHaveLength(1);
  });

  it('needs $SENTRY_TOKEN, and says when Sentry refuses it', async () => {
    const t = { kind: 'sentry' as const, org: 'acme', project: 'web', what: 'new-issue' as const };
    const calls: string[] = [];
    await expect(fetchSentry(t, 'tok', jsonFetch(() => ({ status: 401, body: {} }), calls))).rejects.toThrow(/doesn’t accept SENTRY_TOKEN/);
    expect(calls[0]).toBe('https://sentry.io/api/0/projects/acme/web/issues/?query=is:unresolved&sort=date&statsPeriod=24h');
    vi.useFakeTimers();
    try {
      const k = context<SentryCursor>(sentinel(t));
      const stop = startSentry(t, k.ctx, { store: new Store(initialState('room')), selfId: () => 'me', fetch: jsonFetch(() => ({ body: [] })), env: () => ({}) });
      await vi.advanceTimersByTimeAsync(1);
      expect(k.troubles).toEqual([NO_SENTRY_TOKEN]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Beluga’s own events', () => {
  it('fires on the change only, for its project, and never for what a sentinel’s own run made', async () => {
    const s = setup({ triggers: { warmupMs: 0 } });
    const { store, sentinels } = s;
    store.dispatch({ type: 'projects', projects: [{ ...project('api', 'bob-api'), workspaces: [{ id: 'w9', name: 'fast-checkout', kind: 'worktree', path: '/code/bob-api/w9', branch: 'fast', projectId: 'api' } as never, { id: 'w5', name: 'sentinel/fix', kind: 'worktree', path: '/x', branch: 'sentinel/fix', projectId: 'api' } as never] }, project('land', 'landing')] });
    const watcher = sentinels.create({ name: 'Review new pull requests', projectId: 'api', trigger: { kind: 'beluga', what: 'pr-opened', projectId: 'api' }, steps: [{ kind: 'notify', name: 'Tell me', phone: false }] });
    sentinels.pause(watcher.id, false);
    const runs = () => store.getState().sentinel.runs.filter((r) => r.sentinelId === watcher.id);
    const pr = (n: number, state: 'OPEN' | 'MERGED' = 'OPEN') => ({ number: n, url: `https://github.com/acme/bob-api/pull/${n}`, state, title: `PR ${n}`, draft: false, checks: 'pending' as const });
    store.dispatch({ type: 'pr', id: 'w9', pr: pr(60) });
    await until(() => runs().length === 1);
    expect(runs()[0]).toMatchObject({ by: 'event', trigger: { kind: 'beluga', summary: 'Beluga: pull request #60 opened: PR 60' } });
    // The same pull request again (its checks moved): not news.
    store.dispatch({ type: 'pr', id: 'w9', pr: { ...pr(60), checks: 'passing' } });
    // The sentinel's own run made w5: its pull request never starts it again.
    sentinels.addHistory(watcher.id, { by: 'event', trigger: { kind: 'beluga', summary: 'x' }, state: 'done', startedAt: Date.now(), endedAt: Date.now(), headline: 'x', steps: [], tasks: [], worktreeId: 'w5' });
    store.dispatch({ type: 'pr', id: 'w5', pr: pr(61) });
    await new Promise((r) => setTimeout(r, 30));
    expect(runs().filter((r) => r.headline !== 'x')).toHaveLength(1);
    sentinels.stopAll();
  });

  it('a task done, a milestone, Claude finishing, a friend asking: each once', () => {
    const st = initialState('room');
    const mem = { status: new Map<string, string>([['i1', 'review']]), prs: new Map(), passed: new Set<string>(), asks: new Set<string>() };
    const issue = { id: 'i1', key: 'BOB-4', number: 4, projectId: 'api', title: 'Retry webhooks', status: 'done', priority: 'none', labels: [], blockedBy: [], related: [], rank: 0, brief: {}, revisions: [], worktrees: [], proof: [] } as never;
    const done = belugaEvent({ kind: 'beluga', what: 'task-done' }, { type: 'board_issue', issue }, st, mem as never, 'me');
    expect(done?.summary).toBe('Beluga: BOB-4 is done: Retry webhooks');
    expect(belugaEvent({ kind: 'beluga', what: 'task-done' }, { type: 'board_issue', issue }, st, mem as never, 'me')).toBeUndefined();
    expect(belugaEvent({ kind: 'beluga', what: 'task-done', projectId: 'other' }, { type: 'board_issue', issue: { ...(issue as object), id: 'i2' } as never }, st, mem as never, 'me')).toBeUndefined();
    const plan = { id: 'pl1', projectId: 'api', runs: { m1: { passedAt: 5 } }, body: { title: 'Payments', milestones: [{ id: 'm1', title: 'Checkout works', criteria: ['A test card goes through'] }] } } as never;
    expect(belugaEvent({ kind: 'beluga', what: 'milestone-passed' }, { type: 'plan_put', plan }, st, mem as never, 'me')?.summary).toBe('Beluga: milestone “Checkout works” passed in Payments');
    expect(belugaEvent({ kind: 'beluga', what: 'milestone-passed' }, { type: 'plan_put', plan }, st, mem as never, 'me')).toBeUndefined();
    const withWs = { ...st, projects: [{ ...project('api', 'bob-api'), workspaces: [{ id: 'w1', name: 'retry', kind: 'worktree', path: '/x', projectId: 'api' } as never] }] };
    const finished = { type: 'agent_event' as const, owner: 'me', requestId: 'r', requester: 'me', event: 'done' as const, text: 'All green.', ts: 1, channel: 'ws:w1' };
    expect(belugaEvent({ kind: 'beluga', what: 'claude-finished' }, finished, withWs, mem as never, 'me')?.summary).toBe('Beluga: Claude finished in retry');
    // A friend's Claude's run here isn't yours finishing.
    expect(belugaEvent({ kind: 'beluga', what: 'claude-finished' }, { ...finished, owner: 'friend' }, withWs, mem as never, 'me')).toBeUndefined();
    const task = { id: 't1', direction: 'received', peerId: 'p', peerName: 'Lena', kind: 'ask', ask: 'Can you check the build?', needs: [], by: 'person', state: 'asked', steps: [], createdAt: 0, updatedAt: 0 } as never;
    expect(belugaEvent({ kind: 'beluga', what: 'friend-asks' }, { type: 'gw_task', task }, st, mem as never, 'me')?.summary).toBe('Beluga: Lena asks: Can you check the build?');
    expect(belugaEvent({ kind: 'beluga', what: 'friend-asks' }, { type: 'gw_task', task }, st, mem as never, 'me')).toBeUndefined();
  });
});

// ------------------------------------------------------------------ webhooks

interface Answer {
  readonly status?: number;
  readonly text?: string;
  readonly error?: string;
}

function post(port: number, pathname: string, body: string | Buffer, headers: Record<string, string> = {}, method = 'POST', chunked = false): Promise<Answer> {
  return new Promise((resolve) => {
    const data = typeof body === 'string' ? Buffer.from(body) : body;
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { 'Content-Type': 'application/json', ...(chunked ? {} : { 'Content-Length': String(data.length) }), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    if (chunked) {
      // In pieces, without saying how long: the server counts as it reads.
      const piece = 64 * 1024;
      for (let i = 0; i < data.length; i += piece) req.write(data.subarray(i, i + piece));
      req.end();
    } else req.end(data);
  });
}

describe('the webhook server', () => {
  const secret = newSecret();
  const stripeSecret = 'whsec_test_123';
  let hub: WebhookHub;
  let fired: Array<[string, TriggerEvent]>;
  let states: Array<{ ready: boolean; url?: string }>;
  let signature: 'github' | 'stripe' | undefined;
  let now = Date.now();
  let port = 0;

  beforeEach(async () => {
    fired = [];
    states = [];
    signature = undefined;
    now = Date.now();
    hub = new WebhookHub({
      hook: (id) => (id === 'sn_hook' ? { secret, ...(signature ? { signature } : {}), stripeSecret } : undefined),
      fire: (id, e) => void fired.push([id, e]),
      onState: (st) => void states.push(st),
      tunnel: async () => ({ url: 'https://quiet-harbor.trycloudflare.com/', close: () => undefined }),
      now: () => now,
    });
    hub.add('sn_hook');
    await until(() => hub.localPort() > 0 && hub.base() !== undefined);
    port = hub.localPort();
  });
  afterEach(() => hub.close());

  it('opens with its first webhook sentinel (127.0.0.1, its tunnel) and closes with the last', async () => {
    expect(hub.base()).toBe('https://quiet-harbor.trycloudflare.com');
    expect(states.at(-1)).toEqual({ ready: true, url: 'https://quiet-harbor.trycloudflare.com' });
    hub.remove('sn_hook');
    expect(hub.localPort()).toBe(0);
    expect(states.at(-1)).toEqual({ ready: false });
    expect((await post(port, `/hook/sn_hook/${secret}`, '{}')).error).toBeTruthy();
  });

  it('takes a post with the right secret, and 404s everything else without saying back what was sent', async () => {
    const good = await post(port, `/hook/sn_hook/${secret}`, '{"action":"opened","marker":"SECRET-BODY"}', { 'X-GitHub-Event': 'issues' });
    expect(good).toEqual({ status: 202, text: 'Accepted\n' });
    expect(fired).toHaveLength(1);
    expect(fired[0]![1]).toMatchObject({ summary: 'Webhook from GitHub: issues (opened)', payload: { event: 'issues', headers: { 'x-github-event': 'issues' }, body: { action: 'opened', marker: 'SECRET-BODY' } } });
    const tries = [
      post(port, `/hook/sn_hook/${'0'.repeat(64)}`, '{"marker":"SECRET-BODY"}'),
      post(port, `/hook/sn_hook/${secret.slice(0, 63)}`, 'x'),
      post(port, `/hook/sn_other/${secret}`, 'x'),
      post(port, `/hook/sn_hook/${secret}`, '', {}, 'GET'),
      post(port, '/', 'x'),
      post(port, `/hook/sn_hook/${secret}/more`, 'x'),
    ];
    for (const a of await Promise.all(tries)) {
      expect(a).toEqual({ status: 404, text: 'Not found\n' });
    }
    expect(fired).toHaveLength(1);
  });

  it('checks GitHub’s signature when asked: valid, wrong, missing', async () => {
    signature = 'github';
    const body = '{"ref":"refs/heads/main"}';
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect((await post(port, `/hook/sn_hook/${secret}`, body, { 'X-Hub-Signature-256': sig, 'X-GitHub-Event': 'push' })).status).toBe(202);
    expect(fired[0]![1].summary).toBe('Webhook from GitHub: push');
    expect((await post(port, `/hook/sn_hook/${secret}`, body, { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await post(port, `/hook/sn_hook/${secret}`, `${body} `, { 'X-Hub-Signature-256': sig })).status).toBe(401);
    expect((await post(port, `/hook/sn_hook/${secret}`, body)).status).toBe(401);
    expect(fired).toHaveLength(1);
    expect(githubSignatureOk(Buffer.from(body), sig, secret)).toBe(true);
  });

  it('checks Stripe’s signature when asked: valid, wrong, stale', async () => {
    signature = 'stripe';
    const body = '{"id":"evt_1","type":"invoice.paid"}';
    const signed = (t: number, key = stripeSecret) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;
    const t = Math.floor(now / 1000);
    expect((await post(port, `/hook/sn_hook/${secret}`, body, { 'Stripe-Signature': signed(t) })).status).toBe(202);
    expect(fired[0]![1].summary).toBe('Webhook from Stripe: invoice.paid');
    expect((await post(port, `/hook/sn_hook/${secret}`, body, { 'Stripe-Signature': signed(t, 'whsec_other') })).status).toBe(401);
    expect((await post(port, `/hook/sn_hook/${secret}`, body, { 'Stripe-Signature': signed(t - 6 * 60) })).status).toBe(401);
    expect(stripeSignatureOk(Buffer.from(body), signed(t - 4 * 60), stripeSecret, now)).toBe(true);
    expect(stripeSignatureOk(Buffer.from(body), `t=${t}`, stripeSecret, now)).toBe(false);
    expect(fired).toHaveLength(1);
  });

  it('refuses bodies over 1 MB, said or not, and more than 60 posts a minute', async () => {
    const big = Buffer.alloc(MAX_BODY + 1, 'a');
    const said = await post(port, `/hook/sn_hook/${secret}`, big);
    expect(said.status === 413 || Boolean(said.error)).toBe(true);
    const unsaid = await post(port, `/hook/sn_hook/${secret}`, big, {}, 'POST', true);
    expect(unsaid.status === 413 || Boolean(unsaid.error)).toBe(true);
    expect(fired).toHaveLength(0);
    expect((await post(port, `/hook/sn_hook/${secret}`, Buffer.alloc(MAX_BODY, 'a'))).status).toBe(202);
    for (let i = 0; i < PER_MINUTE - 3; i++) await post(port, `/hook/sn_hook/${secret}`, '{}');
    const over = await post(port, `/hook/sn_hook/${secret}`, '{}');
    expect(over).toEqual({ status: 429, text: 'Too many posts: at most 60 a minute\n' });
    now += 61_000;
    expect((await post(port, `/hook/sn_hook/${secret}`, '{}')).status).toBe(202);
  });

  it('compares secrets in constant time, any lengths', () => {
    expect(sameSecret(secret, secret)).toBe(true);
    expect(sameSecret(secret, `${secret}0`)).toBe(false);
    expect(sameSecret('', secret)).toBe(false);
    expect(newSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('webhook sentinels: the URL and the secret', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-hooks-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a secret from the start, in the file only; the URL while it’s on; Rotate Secret makes a new one', async () => {
    const s = setup({ dir, saveDelayMs: 0, triggers: { tunnel: async () => ({ url: 'https://quiet-harbor.trycloudflare.com', close: () => undefined }) } });
    const hook = s.sentinels.create({ name: 'GitHub pushes', trigger: { kind: 'webhook', signature: 'github' }, steps: [{ kind: 'notify', name: 'Tell me', phone: false }] });
    // Paused: no tunnel for it yet.
    expect(s.sentinels.webhookUrl(hook.id)).toEqual({ why: 'It’s paused: posts to its URL are refused until you turn it on' });
    s.sentinels.pause(hook.id, false);
    await until(() => s.store.getState().sentinel.webhook?.ready === true);
    const { url } = s.sentinels.webhookUrl(hook.id);
    expect(url).toMatch(new RegExp(`^https://quiet-harbor\\.trycloudflare\\.com/hook/${hook.id}/[0-9a-f]{64}$`));
    const secret = url!.split('/').at(-1)!;
    await new Promise((r) => setTimeout(r, 10));
    const file = readFileSync(path.join(dir, 'sentinel.json'), 'utf8');
    expect(JSON.parse(file).secrets[hook.id]).toBe(secret);
    // Never in the state.
    expect(JSON.stringify(s.store.getState().sentinel)).not.toContain(secret);
    const rotated = s.sentinels.rotateSecret(hook.id);
    expect(rotated.url).not.toContain(secret);
    expect(rotated.url).toMatch(/\/[0-9a-f]{64}$/);
    // A post with the old secret is refused; the new one is taken.
    const port = (s.sentinels as unknown as { triggers: Triggers }).triggers.webhooks.localPort();
    expect((await post(port, `/hook/${hook.id}/${secret}`, '{}')).status).toBe(404);
    expect((await post(port, new URL(rotated.url!).pathname, '{}')).status).toBe(401);
    const body = '{"zen":"Keep it simple"}';
    const sig = `sha256=${createHmac('sha256', rotated.url!.split('/').at(-1)!).update(body).digest('hex')}`;
    expect((await post(port, new URL(rotated.url!).pathname, body, { 'X-Hub-Signature-256': sig, 'X-GitHub-Event': 'ping' })).status).toBe(202);
    expect(() => s.sentinels.webhookUrl(s.sentinels.create({ name: 'Clock', trigger: { kind: 'manual' } }).id)).toThrow('doesn’t start from a webhook');
    // Paused again: the server closes with its last webhook sentinel.
    s.sentinels.pause(hook.id, true);
    expect(s.store.getState().sentinel.webhook).toEqual({ ready: false });
    s.sentinels.stopAll();
  });

  it('a post reaches its sentinel as a run by the event, with the payload for Claude and scripts', async () => {
    const s = setup({ triggers: { tunnel: async () => ({ url: 'https://h.trycloudflare.com', close: () => undefined }) } });
    const hook = s.sentinels.create({ name: 'Pushes', trigger: { kind: 'webhook' }, steps: [{ kind: 'script', name: 'Echo', command: 'echo "$SENTINEL_TRIGGER"', cwd: 'home', timeoutSec: 10 }] });
    s.sentinels.pause(hook.id, false);
    await until(() => s.store.getState().sentinel.webhook?.ready === true);
    const url = new URL(s.sentinels.webhookUrl(hook.id).url!);
    const internal = (s.sentinels as unknown as { triggers: Triggers }).triggers;
    const res = await post(internal.webhooks.localPort(), url.pathname, '{"hello":"there"}', { 'X-GitHub-Event': 'ping' });
    expect(res.status).toBe(202);
    await until(() => s.ran.length === 1);
    expect(JSON.parse(s.ran[0]!.env.SENTINEL_TRIGGER!)).toMatchObject({ kind: 'webhook', summary: 'Webhook from GitHub: ping', payload: { body: { hello: 'there' } } });
    expect(s.store.getState().sentinel.runs.find((r) => r.sentinelId === hook.id)).toMatchObject({ by: 'event' });
    s.sentinels.stopAll();
  });
});

describe('the Triggers coordinator', () => {
  it('starts a watcher when a sentinel is on, stops it on pause and delete, and restarts it when its trigger changes', async () => {
    vi.useFakeTimers();
    try {
      const looked: string[] = [];
      const deps: Omit<TriggerDeps, 'store' | 'selfId'> = { fetch: async (url) => (looked.push(url), { status: 200, text: async () => 'ok' }) };
      const store = new Store(initialState('room'));
      store.dispatch({ type: 'projects', projects: [project('api', 'bob-api')] });
      const sentinels = new Sentinels({ store, dir: null, selfId: () => 'me', notify: () => undefined, tickMs: 0, triggers: deps });
      const internal = (sentinels as unknown as { triggers: Triggers }).triggers;
      const up = sentinels.create({ name: 'Uptime', trigger: { kind: 'uptime', url: 'https://example.com', minutes: 1 } });
      expect(internal.watching()).toEqual([]);
      sentinels.pause(up.id, false);
      expect(internal.watching()).toEqual([up.id]);
      await vi.advanceTimersByTimeAsync(2 * MIN + 1);
      expect(looked).toEqual(['https://example.com', 'https://example.com', 'https://example.com']);
      // Its cursor is kept: it's up.
      expect((sentinels as unknown as { cursors: Record<string, unknown> }).cursors[up.id]).toMatchObject({ state: 'up' });
      sentinels.update(up.id, { trigger: { kind: 'uptime', url: 'https://example.org', minutes: 1 } });
      expect((sentinels as unknown as { cursors: Record<string, unknown> }).cursors[up.id]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(looked.at(-1)).toBe('https://example.org');
      sentinels.pause(up.id, true);
      expect(internal.watching()).toEqual([]);
      const n = looked.length;
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(looked).toHaveLength(n);
      sentinels.pause(up.id, false);
      expect(internal.watching()).toEqual([up.id]);
      sentinels.remove(up.id);
      expect(internal.watching()).toEqual([]);
      // A schedule never has a watcher.
      const sched = sentinels.create({ name: 'Brief', trigger: { kind: 'schedule', every: 'day', at: '07:00', missed: 'skip' } });
      sentinels.pause(sched.id, false);
      expect(internal.watching()).toEqual([]);
      // Stopping the daemon stops them all.
      const again = sentinels.create({ name: 'Uptime 2', trigger: { kind: 'uptime', url: 'https://example.net', minutes: 1 } });
      sentinels.pause(again.id, false);
      sentinels.stopAll();
      expect(internal.watching()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a site that goes down starts one run, and coming back starts one more', async () => {
    vi.useFakeTimers();
    try {
      let status = 200;
      const s = setup({ triggers: { fetch: async () => ({ status, text: async () => '' }) } });
      const guard = s.sentinels.create({ name: 'Uptime guard', projectId: 'land', trigger: { kind: 'uptime', url: 'https://landing.example.com', minutes: 1 }, steps: [{ kind: 'script', name: 'Note', command: 'true', cwd: 'home', timeoutSec: 10 }] });
      s.sentinels.pause(guard.id, false);
      const runs = () => s.store.getState().sentinel.runs.filter((r) => r.sentinelId === guard.id);
      await vi.advanceTimersByTimeAsync(1);
      status = 503;
      await vi.advanceTimersByTimeAsync(MIN);
      expect(runs()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(3 * MIN);
      expect(runs().map((r) => r.trigger.summary)).toEqual(['landing.example.com stopped answering (503)']);
      status = 200;
      await vi.advanceTimersByTimeAsync(3 * MIN);
      expect(runs().map((r) => r.trigger.summary)).toEqual(['landing.example.com stopped answering (503)', expect.stringMatching(/^landing\.example\.com is back \(200, \d+ ms\)$/)]);
      s.sentinels.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a watcher’s trouble in the state, and clears it when paused', async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ triggers: { fetch: async () => ({ status: 200, text: async () => '[]' }), env: () => ({}) } });
      const watch = s.sentinels.create({ name: 'Errors', trigger: { kind: 'sentry', org: 'acme', project: 'web', what: 'new-issue' } });
      s.sentinels.pause(watch.id, false);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.store.getState().sentinel.troubles).toEqual({ [watch.id]: NO_SENTRY_TOKEN });
      s.sentinels.pause(watch.id, true);
      expect(s.store.getState().sentinel.troubles).toEqual({});
      s.sentinels.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });
});
