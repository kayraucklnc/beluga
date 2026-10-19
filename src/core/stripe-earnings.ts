/**
 * Each project's earnings from Stripe: you connect a key per project, klaud counts what the
 * account earned (see stripe-client.ts for exactly what counts) in the background, once a
 * day, and keeps the running count so the next look only reads what's new. The keys live in
 * ~/.klaud/stripe.json, readable only by you, and never leave this computer: screens get
 * "connected", the account's name and the totals (core/earnings-store.ts), nothing more.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { EarningsError, MoneyTotal, ProjectEarnings } from './earnings-store.js';
import { STRIPE_KEY, stripeKeyProblem } from '../shared/stripe-keys.js';
import { klaudHome } from './home.js';
import type { Store } from './store.js';
import { type StripeOptions, type Tally, StripeError, accountName, catchUp, checkKey, fullCount } from './stripe-client.js';

/** Refresh when the last count is older than this (about once a day, whenever klaud is open). */
export const STALE_MS = 20 * 3600_000;
/** Count everything again this often, to correct anything the quick looks missed. */
export const FULL_RECOUNT_MS = 7 * 24 * 3600_000;
/** How often klaud checks whether a refresh is due. */
const CHECK_MS = 3600_000;
/** The first check waits a little, so it doesn't compete with klaud starting. */
const FIRST_CHECK_MS = 8_000;

const TallySchema = z.object({
  totals: z.record(z.string(), z.number()),
  newest: z.object({ created: z.number(), ids: z.array(z.string()) }).optional(),
  syncedAt: z.number(),
  seenRefunds: z.array(z.string()).default([]),
  fullAt: z.number(),
});

const ErrorSchema = z.object({ code: z.enum(['revoked', 'permission', 'offline', 'rate_limited', 'stripe', 'unknown']), message: z.string(), at: z.number() });

const EntrySchema = z.object({
  key: z.string().regex(STRIPE_KEY),
  account: z.string().optional(),
  tally: TallySchema.optional(),
  updatedAt: z.number().optional(),
  error: ErrorSchema.optional(),
});
interface Entry {
  readonly key: string;
  readonly account?: string;
  readonly tally?: Tally;
  readonly updatedAt?: number;
  readonly error?: EarningsError;
}

/** What stripe.json holds: by project folder. */
export const StripeFileSchema = z.object({ projects: z.record(z.string(), EntrySchema).default({}) });
export interface StripeFile {
  readonly projects: Readonly<Record<string, Entry>>;
}

const EMPTY: StripeFile = { projects: {} };

export const stripePath = (): string => path.join(klaudHome(), 'stripe.json');

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

  /** Refresh the projects whose count is older than a day (skipping keys Stripe refused: they need you). */
  async refreshIfStale(maxAgeMs: number = STALE_MS): Promise<void> {
    const now = this.now();
    for (const [root, e] of Object.entries(this.data.projects)) {
      const needsYou = e.error && (e.error.code === 'revoked' || e.error.code === 'permission');
      if (needsYou || (e.updatedAt && now - e.updatedAt < maxAgeMs)) continue;
      await this.refreshRoot(root);
    }
  }

  private refreshRoot(root: string, full = false): Promise<void> {
    const busy = this.running.get(root);
    if (busy) return busy;
    const run = this.count(root, full).finally(() => this.running.delete(root));
    this.running.set(root, run);
    return run;
  }

  private async count(root: string, forceFull: boolean): Promise<void> {
    const start = this.data.projects[root];
    if (!start) return;
    this.publish(root, true);
    const full = forceFull || !start.tally || this.now() - start.tally.fullAt > FULL_RECOUNT_MS;
    let tally: Tally | undefined;
    let error: EarningsError | undefined;
    try {
      tally = full || !start.tally ? await fullCount(start.key, this.stripe) : await catchUp(start.key, start.tally, this.stripe);
    } catch (err) {
      const e = err instanceof StripeError ? err : new StripeError('unknown');
      error = { code: e.code, message: e.message, at: this.now() };
    }
    // Disconnected, or connected with another key, while counting: this count is for nothing.
    const now = this.data.projects[root];
    if (!now || now.key !== start.key) return this.publish(root);
    const { error: _old, ...rest } = now;
    this.put(root, tally ? { ...rest, tally, updatedAt: this.now() } : { ...rest, ...(error ? { error } : {}) });
    this.publish(root);
  }

  /** Refresh in the background: soon after starting, then whenever a day has gone by. */
  start(): void {
    this.first = setTimeout(() => void this.refreshIfStale(), FIRST_CHECK_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.refreshIfStale(), CHECK_MS);
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

/** The earnings service of this session, or a clear error where there's none (the terminal app). */
export function earningsOf(session: object): StripeEarnings {
  const service = services.get(session);
  if (!service) throw new Error('Earnings from Stripe live in the klaud app for Mac (its daemon).');
  return service;
}
