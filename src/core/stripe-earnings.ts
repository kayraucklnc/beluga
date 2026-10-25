/**
 * Each project's earnings from Stripe: you connect a key per project, Beluga counts what the
 * account earned (see stripe-client.ts for exactly what counts) in the background, looking for
 * new payments every few minutes, and keeps the running count so each look only reads what's
 * new. When something came in (and at least once a day) it also reads the last months of
 * charges for what the project did lately (stripe-activity.ts). The keys live in
 * ~/.beluga/stripe.json, readable only by you, and never leave this computer: screens get
 * "connected", the account's name, the totals and that recent activity (core/earnings-store.ts),
 * nothing more.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type EarningsActivity, type EarningsError, type MoneyTotal, type ProjectEarnings, dayKey } from './earnings-store.js';
import { STRIPE_KEY, stripeKeyProblem } from '../shared/stripe-keys.js';
import { belugaHome } from './home.js';
import type { Store } from './store.js';
import { activitySince, summarizeActivity } from './stripe-activity.js';
import { type StripeOptions, type Tally, StripeError, accountName, catchUp, checkKey, fullCount, recentCharges } from './stripe-client.js';

/** Read the last months again when they're older than this, even if nothing new came in. */
export const STALE_MS = 20 * 3600_000;
/** Count everything again this often, to correct anything the quick looks missed. */
export const FULL_RECOUNT_MS = 7 * 24 * 3600_000;
/** How often Beluga looks for new payments (two small requests per project when nothing's new). */
export const WATCH_MS = 10 * 60_000;
/** The first check waits a little, so it doesn't compete with Beluga starting. */
const FIRST_CHECK_MS = 8_000;

const TallySchema = z.object({
  totals: z.record(z.string(), z.number()),
  newest: z.object({ created: z.number(), ids: z.array(z.string()) }).optional(),
  syncedAt: z.number(),
  seenRefunds: z.array(z.string()).default([]),
  fullAt: z.number(),
});

const ErrorSchema = z.object({ code: z.enum(['revoked', 'permission', 'offline', 'rate_limited', 'stripe', 'unknown']), message: z.string(), at: z.number() });

const Money = z.object({ currency: z.string(), amount: z.number() });
const ActivitySchema = z.object({
  days: z.array(z.object({ day: z.string(), totals: z.array(Money), payments: z.number() })),
  payers: z.array(z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]), now: z.number(), before: z.number() })),
  latest: z.array(
    z.object({
      id: z.string(),
      at: z.number(),
      amount: z.number(),
      currency: z.string(),
      refunded: z.number().optional(),
      status: z.enum(['paid', 'partly_refunded', 'refunded', 'pending', 'failed']),
      who: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
  from: z.string(),
  at: z.number(),
  partial: z.boolean().optional(),
});

const EntrySchema = z.object({
  key: z.string().regex(STRIPE_KEY),
  account: z.string().optional(),
  tally: TallySchema.optional(),
  // A file from before activity was read, or one this can't read: read it again.
  activity: ActivitySchema.optional().catch(undefined),
  updatedAt: z.number().optional(),
  error: ErrorSchema.optional(),
});
interface Entry {
  readonly key: string;
  readonly account?: string;
  readonly tally?: Tally;
  readonly activity?: EarningsActivity;
  readonly updatedAt?: number;
  readonly error?: EarningsError;
}

/** What stripe.json holds: by project folder. */
export const StripeFileSchema = z.object({ projects: z.record(z.string(), EntrySchema).default({}) });
export interface StripeFile {
  readonly projects: Readonly<Record<string, Entry>>;
}

const EMPTY: StripeFile = { projects: {} };

export const stripePath = (): string => path.join(belugaHome(), 'stripe.json');

export function loadStripeFile(file: string = stripePath()): StripeFile {
  try {
    const parsed = StripeFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** Save atomically, readable only by you. */
export function saveStripeFile(data: StripeFile, file: string = stripePath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export { stripeKeyProblem };

/** What connecting says back (never the key). */
export interface StripeConnected {
  readonly account?: string;
  readonly mode: 'test' | 'live';
  readonly secretKey: boolean;
}

export interface StripeEarningsDeps {
  readonly store: Store;
  /** Where the keys are kept; null: only in memory (the demo). */
  readonly file?: string | null;
  readonly stripe?: StripeOptions;
  readonly now?: () => number;
  /** How often to look for new payments (WATCH_MS; the demo looks more often). */
  readonly watchMs?: number;
}

const CONNECT_ERRORS: Record<string, string> = {
  revoked: 'Stripe doesn’t know this key. Check you copied all of it, or create a new one.',
  permission: 'This key can’t read charges. Edit it in Stripe and set Charges to Read.',
  offline: 'Couldn’t reach Stripe. Check your connection and try again.',
  rate_limited: 'Stripe is busy right now. Try again in a minute.',
  stripe: 'Stripe had a problem answering. Try again in a minute.',
};

export class StripeEarnings {
  private data: StripeFile;
  private readonly running = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(private readonly deps: StripeEarningsDeps) {
    this.data = deps.file === null ? EMPTY : loadStripeFile(deps.file);
    for (const root of Object.keys(this.data.projects)) this.publish(root);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get stripe(): StripeOptions {
    return { ...(this.deps.now ? { now: this.deps.now } : {}), ...this.deps.stripe };
  }

  private rootOf(projectId: string): string {
    const root = this.deps.store.getState().projects.find((p) => p.id === projectId)?.root;
    if (!root) throw new Error('That project is gone');
    return root;
  }

  private save(): void {
    if (this.deps.file !== null) saveStripeFile(this.data, this.deps.file);
  }

  private put(root: string, entry: Entry | undefined): void {
    const { [root]: _old, ...others } = this.data.projects;
    this.data = { projects: entry ? { ...others, [root]: entry } : others };
    this.save();
  }

  /** Tell screens what they may know: connected, the account's name, the totals. */
  private publish(root: string, refreshing = false): void {
    const e = this.data.projects[root];
    if (!e) return void this.deps.store.dispatch({ type: 'earnings', root });
    const totals: MoneyTotal[] | undefined = e.tally
      ? Object.entries(e.tally.totals)
          .filter(([, amount]) => amount > 0)
          .map(([currency, amount]) => ({ currency, amount }))
          .sort((a, b) => b.amount - a.amount)
      : undefined;
    const earnings: ProjectEarnings = {
      connected: true,
      mode: e.key.includes('_live_') ? 'live' : 'test',
      ...(e.key.startsWith('sk_') ? { secretKey: true } : {}),
      ...(e.account ? { account: e.account } : {}),
      ...(totals ? { totals } : {}),
      ...(e.activity ? { activity: e.activity } : {}),
      ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
      ...(refreshing ? { refreshing } : {}),
      ...(e.error ? { error: e.error } : {}),
    };
    this.deps.store.dispatch({ type: 'earnings', root, earnings });
  }

  /** Check the key with Stripe, keep it, and start counting in the background. */
  async connect(projectId: string, raw: string): Promise<StripeConnected> {
    const key = raw.trim();
    const problem = stripeKeyProblem(key);
    if (problem) throw new Error(problem);
    const root = this.rootOf(projectId);
    try {
      await checkKey(key, this.stripe);
    } catch (err) {
      throw new Error(err instanceof StripeError ? (CONNECT_ERRORS[err.code] ?? err.message) : 'Couldn’t check the key with Stripe');
    }
    const account = await accountName(key, this.stripe);
    this.put(root, { key, ...(account ? { account } : {}) });
    this.publish(root, true);
    // A count for an earlier key may still be running: this one starts after it.
    void (this.running.get(root) ?? Promise.resolve()).then(() => this.refreshRoot(root));
    return { ...(account ? { account } : {}), mode: key.includes('_live_') ? 'live' : 'test', secretKey: key.startsWith('sk_') };
  }

  /** Forget a project's key and its totals. */
  disconnect(projectId: string): void {
    const root = this.rootOf(projectId);
    this.put(root, undefined);
    this.publish(root);
  }

  /** Bring one project's earnings (or every connected project's, one after another) up to date now. */
  async refresh(projectId?: string, opts: { readonly full?: boolean } = {}): Promise<void> {
    if (projectId) return this.refreshRoot(this.rootOf(projectId), opts.full);
    for (const root of Object.keys(this.data.projects)) await this.refreshRoot(root, opts.full);
  }

  /**
   * Refresh the projects whose count is older than `maxAgeMs` (skipping keys Stripe refused: they
   * need you). `quiet`: the background look for new payments, which screens don't show as counting.
   */
  async refreshIfStale(maxAgeMs: number = STALE_MS, opts: { readonly quiet?: boolean } = {}): Promise<void> {
    const now = this.now();
    for (const [root, e] of Object.entries(this.data.projects)) {
      const needsYou = e.error && (e.error.code === 'revoked' || e.error.code === 'permission');
      if (needsYou || (e.updatedAt && now - e.updatedAt < maxAgeMs)) continue;
      await this.refreshRoot(root, false, opts.quiet);
    }
  }

  private refreshRoot(root: string, full = false, quiet = false): Promise<void> {
    const busy = this.running.get(root);
    if (busy) return busy;
    const run = this.count(root, full, quiet).finally(() => this.running.delete(root));
    this.running.set(root, run);
    return run;
  }

  /** The last months need reading again: asked for, the last look failed, something came in, or they're from another day. */
  private activityDue(start: Entry, tally: Tally, force: boolean): boolean {
    const a = start.activity;
    if (force || !a || !start.tally || start.error) return true;
    const now = this.now();
    if (now - a.at > STALE_MS || dayKey(a.at) !== dayKey(now)) return true;
    const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
    return !same(start.tally.newest, tally.newest) || !same(start.tally.totals, tally.totals);
  }

  private async count(root: string, forceFull: boolean, quiet = false): Promise<void> {
    const start = this.data.projects[root];
    if (!start) return;
    const full = forceFull || !start.tally || this.now() - start.tally.fullAt > FULL_RECOUNT_MS;
    // A quick look in the background doesn't show as counting (a full count does).
    if (!quiet || full) this.publish(root, true);
    let tally: Tally | undefined;
    let activity = start.activity;
    let error: EarningsError | undefined;
    const failed = (err: unknown): EarningsError => {
      const e = err instanceof StripeError ? err : new StripeError('unknown');
      return { code: e.code, message: e.message, at: this.now() };
    };
    try {
      tally = full || !start.tally ? await fullCount(start.key, this.stripe) : await catchUp(start.key, start.tally, this.stripe);
    } catch (err) {
      error = failed(err);
    }
    // Refresh Now (or connecting) reads everything; a quick look only when something changed.
    if (tally && this.activityDue(start, tally, full || !quiet)) {
      try {
        const now = this.now();
        const recent = await recentCharges(start.key, activitySince(now), this.stripe);
        activity = summarizeActivity(recent.charges, now, recent.partial);
      } catch (err) {
        // The totals are counted; what it did lately stays as last read until next time.
        error = failed(err);
      }
    }
    // Disconnected, or connected with another key, while counting: this count is for nothing.
    const now = this.data.projects[root];
    if (!now || now.key !== start.key) return this.publish(root);
    const { error: _old, ...rest } = now;
    this.put(root, tally ? { ...rest, tally, ...(activity ? { activity } : {}), updatedAt: this.now(), ...(error ? { error } : {}) } : { ...rest, ...(error ? { error } : {}) });
    this.publish(root);
  }

  /** Refresh in the background: soon after starting, then look for new payments every few minutes. */
  start(): void {
    const every = this.deps.watchMs ?? WATCH_MS;
    // Half the interval: a look that ran a little late still counts as recent.
    const watch = (): void => void this.refreshIfStale(every / 2, { quiet: true });
    this.first = setTimeout(watch, FIRST_CHECK_MS);
    this.first.unref();
    this.timer = setInterval(watch, every);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /** Every running count has finished (tests). */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }
}

const services = new WeakMap<object, StripeEarnings>();

export const attachEarnings = (session: object, service: StripeEarnings): void => void services.set(session, service);

/** The earnings service of this session, or a clear error where there's none (no daemon running it, e.g. tests). */
export function earningsOf(session: object): StripeEarnings {
  const service = services.get(session);
  if (!service) throw new Error('Earnings from Stripe live in the Beluga app for Mac (its daemon).');
  return service;
}
