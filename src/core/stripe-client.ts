import type { EarningsErrorCode } from './earnings-store.js';

/**
 * Reading what a Stripe account earned, with nothing but fetch: a key, sequential pages of
 * 100, patience when Stripe says slow down. What counts as earned: every successful charge,
 * what was captured minus what was refunded (gross, before Stripe's fees; disputes aren't
 * taken off). The key goes into the Authorization header and nowhere else: errors carry
 * klaud's own words, never Stripe's (which can quote part of the key).
 */

export const STRIPE_API = 'https://api.stripe.com';

/** The part of fetch this uses (tests and the demo pass their own). */
export type FetchLike = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<{ readonly status: number; readonly headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export interface StripeOptions {
  readonly fetch?: FetchLike;
  /** Where the API is (KLAUD_STRIPE_API, for a fake Stripe). */
  readonly base?: string;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxRetries?: number;
  /** A count stops after this many pages (a million charges) rather than run forever. */
  readonly maxPages?: number;
  /** The clock, in ms (Stripe counts in seconds). */
  readonly now?: () => number;
}

const MESSAGES: Record<EarningsErrorCode, string> = {
  revoked: 'Stripe doesn’t accept this key anymore (it was revoked or rolled). Connect a new one.',
  permission: 'No permission to read charges — add Charges: Read to the key.',
  offline: 'Couldn’t reach Stripe. The last total stays until klaud can try again.',
  rate_limited: 'Stripe asked klaud to slow down. It tries again later.',
  stripe: 'Stripe had a problem answering. klaud tries again later.',
  unknown: 'Couldn’t read the earnings from Stripe.',
};

export class StripeError extends Error {
  constructor(
    readonly code: EarningsErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.name = 'StripeError';
  }
}

const DEFAULTS = { timeoutMs: 20_000, maxRetries: 4, maxPages: 10_000 };
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One GET, retried on 429 and 5xx (Retry-After, else 1s, 2s, 4s…). */
async function get(key: string, pathAndQuery: string, opts: StripeOptions): Promise<unknown> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const retries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const sleep = opts.sleep ?? sleepMs;
  for (let attempt = 0; ; attempt++) {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(`${opts.base ?? STRIPE_API}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULTS.timeoutMs),
      });
    } catch {
      throw new StripeError('offline');
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new StripeError(res.status === 429 ? 'rate_limited' : 'stripe');
      const after = Number(res.headers.get('retry-after'));
      await sleep(after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 401) throw new StripeError('revoked');
    if (res.status === 403) throw new StripeError('permission');
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new StripeError('stripe');
    }
    if (res.status >= 400) {
      const err = (body as { error?: { type?: string; message?: string } } | undefined)?.error;
      if (/permission/i.test(err?.message ?? '')) throw new StripeError('permission');
      throw new StripeError('unknown');
    }
    return body;
  }
}

interface Page<T> {
  readonly data: readonly T[];
  readonly has_more: boolean;
}

function isPage<T>(v: unknown): v is Page<T> {
  return typeof v === 'object' && v !== null && Array.isArray((v as Page<T>).data) && typeof (v as Page<T>).has_more === 'boolean';
}

/** Every object of a list, newest first, one page of 100 at a time. */
async function* list<T extends { readonly id: string }>(key: string, path: string, params: Record<string, string | number>, opts: StripeOptions): AsyncGenerator<T> {
  let after: string | undefined;
  const max = opts.maxPages ?? DEFAULTS.maxPages;
  for (let page = 0; page < max; page++) {
    const query = new URLSearchParams({ limit: '100', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), ...(after ? { starting_after: after } : {}) });
    const body = await get(key, `${path}?${query.toString()}`, opts);
    if (!isPage<T>(body)) throw new StripeError('stripe');
    for (const item of body.data) yield item;
    const last = body.data[body.data.length - 1];
    if (!body.has_more || !last) return;
    after = last.id;
  }
  throw new StripeError('unknown', 'This account has more charges than klaud counts in one go.');
}

/** The fields of a charge this reads. */
export interface Charge {
  readonly id: string;
  readonly created: number;
  readonly currency: string;
  readonly status?: string;
  readonly paid?: boolean;
  readonly captured?: boolean;
  readonly amount: number;
  readonly amount_captured?: number;
  readonly amount_refunded?: number;
}

export interface Refund {
  readonly id: string;
  readonly created: number;
  readonly currency: string;
  readonly amount: number;
  readonly status?: string;
  readonly charge?: string | { readonly id: string } | null;
}

/** What one charge adds: captured minus refunded, for successful ones only. */
export function chargeNet(c: Charge): number {
  if (c.status !== 'succeeded' || c.paid === false) return 0;
  const captured = typeof c.amount_captured === 'number' ? c.amount_captured : c.captured === false ? 0 : c.amount;
  return Math.max(0, captured - (c.amount_refunded ?? 0));
}

/** The running count kept between refreshes (in ~/.klaud/stripe.json, beside the key). */
export interface Tally {
  /** Smallest currency unit, by lowercase currency. */
  readonly totals: Readonly<Record<string, number>>;
  /** The newest charge counted: its second, and every charge id counted at that second. */
  readonly newest?: { readonly created: number; readonly ids: readonly string[] };
  /** When the last count began (seconds): refunds from then on are looked at next time. */
  readonly syncedAt: number;
  /** Refunds already taken off that the next look may see again. */
  readonly seenRefunds: readonly string[];
  /** When the last full count finished (ms). */
  readonly fullAt: number;
}

const add = (totals: Record<string, number>, currency: string, amount: number): void => {
  if (amount) totals[currency.toLowerCase()] = (totals[currency.toLowerCase()] ?? 0) + amount;
};

const nowMs = (opts: StripeOptions): number => opts.now?.() ?? Date.now();
const nowSec = (opts: StripeOptions): number => Math.floor(nowMs(opts) / 1000);

function newestOf(prev: Tally['newest'], charges: readonly Charge[]): Tally['newest'] {
  let newest = prev;
  for (const c of charges) {
    if (!newest || c.created > newest.created) newest = { created: c.created, ids: [c.id] };
    else if (c.created === newest.created && !newest.ids.includes(c.id)) newest = { created: newest.created, ids: [...newest.ids, c.id] };
  }
  return newest;
}

/** Count every charge the account ever had. */
export async function fullCount(key: string, opts: StripeOptions = {}): Promise<Tally> {
  const syncedAt = nowSec(opts);
  const totals: Record<string, number> = {};
  const atNewest: Charge[] = [];
  for await (const c of list<Charge>(key, '/v1/charges', {}, opts)) {
    add(totals, c.currency, chargeNet(c));
    // Newest first: the charges sharing the first one's second are the edge to resume from.
    if (!atNewest.length || c.created === atNewest[0]!.created) atNewest.push(c);
  }
  return { totals, newest: newestOf(undefined, atNewest), syncedAt, seenRefunds: [], fullAt: nowMs(opts) };
}

/**
 * Bring a count up to date: charges since the newest one counted, then refunds since the
 * last count on charges counted before (new charges already have theirs taken off).
 */
export async function catchUp(key: string, prev: Tally, opts: StripeOptions = {}): Promise<Tally> {
  const syncedAt = nowSec(opts);
  const totals: Record<string, number> = { ...prev.totals };
  const fresh: Charge[] = [];
  const counted = new Set(prev.newest?.ids ?? []);
  const since: Record<string, number> = prev.newest ? { 'created[gte]': prev.newest.created } : {};
  for await (const c of list<Charge>(key, '/v1/charges', since, opts)) {
    if (counted.has(c.id)) continue;
    fresh.push(c);
    add(totals, c.currency, chargeNet(c));
  }
  const freshIds = new Set(fresh.map((c) => c.id));
  const seenBefore = new Set(prev.seenRefunds);
  const seen: string[] = [];
  for await (const r of list<Refund>(key, '/v1/refunds', { 'created[gte]': prev.syncedAt }, opts)) {
    if (r.created >= syncedAt) seen.push(r.id);
    const charge = typeof r.charge === 'string' ? r.charge : r.charge?.id;
    if (seenBefore.has(r.id) || (charge && freshIds.has(charge)) || r.status === 'failed' || r.status === 'canceled') continue;
    add(totals, r.currency, -r.amount);
  }
  for (const [currency, amount] of Object.entries(totals)) if (amount < 0) totals[currency] = 0;
  return { totals, newest: newestOf(prev.newest, fresh), syncedAt, seenRefunds: seen, fullAt: prev.fullAt };
}

/** The key may read charges (the one permission klaud needs): throws a StripeError if not. */
export async function checkKey(key: string, opts: StripeOptions = {}): Promise<void> {
  await get(key, '/v1/charges?limit=1', opts);
}

/**
 * The account's display name, if the key may read the account (restricted keys need
 * Connect › Accounts: Read for that; without it there's just no name).
 */
export async function accountName(key: string, opts: StripeOptions = {}): Promise<string | undefined> {
  try {
    const a = (await get(key, '/v1/account', { ...opts, maxRetries: 1 })) as { settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string }; email?: string } | undefined;
    const name = a?.settings?.dashboard?.display_name || a?.business_profile?.name || a?.email;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}
