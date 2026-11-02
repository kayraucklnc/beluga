/**
 * What each project earned, from its Stripe account, in the shared state: whether Stripe is
 * connected, the account's name, all-time totals per currency, when they were counted, and
 * what went wrong. Never the key itself (that stays in ~/.beluga/stripe.json, see
 * core/stripe-earnings.ts). Browser-safe: the Mac app runs it.
 */

/** One currency's total, in its smallest unit (cents for USD, yen for JPY). */
export interface MoneyTotal {
  /** Lowercase ISO code, as Stripe sends it ("usd"). */
  readonly currency: string;
  readonly amount: number;
}

export type EarningsErrorCode = 'revoked' | 'permission' | 'offline' | 'rate_limited' | 'stripe' | 'unknown';

export interface EarningsError {
  readonly code: EarningsErrorCode;
  /** Says what happened and what to do, ready to show. */
  readonly message: string;
  readonly at: number;
}

/** The ranges recent earnings come in: the last 7, 30 and 90 days (today included). */
export const EARNINGS_RANGES = [7, 30, 90] as const;
export type EarningsRange = (typeof EARNINGS_RANGES)[number];

/** How far back the recent figures read: the longest range and the one before it, to compare. */
export const ACTIVITY_DAYS = 2 * EARNINGS_RANGES[EARNINGS_RANGES.length - 1]!;

/** One day that had payments. */
export interface EarningsDay {
  /** The day on this Mac's calendar ("2026-10-25", see dayKey). */
  readonly day: string;
  /** Earned that day per currency, smallest unit, biggest first: captured minus refunded. */
  readonly totals: readonly MoneyTotal[];
  /** Successful payments that day. */
  readonly payments: number;
}

export type PaymentStatus = 'paid' | 'partly_refunded' | 'refunded' | 'pending' | 'failed';

/** One of the latest payments, as screens see it: never more of the customer than a first name or a masked email. */
export interface RecentPayment {
  /** Stripe's charge id (to tell a new payment from the ones already seen). */
  readonly id: string;
  /** When (ms). */
  readonly at: number;
  /** What was charged, in the smallest unit. */
  readonly amount: number;
  readonly currency: string;
  /** What was given back. */
  readonly refunded?: number;
  readonly status: PaymentStatus;
  /** "Maya K." or "m•••@gmail.com". */
  readonly who?: string;
  readonly description?: string;
}

/** Distinct paying customers in a range, and in the same span just before it. */
export interface PayerCount {
  readonly days: EarningsRange;
  readonly now: number;
  readonly before: number;
}

/** What a project did lately, read from its last ACTIVITY_DAYS days of charges. */
export interface EarningsActivity {
  /** The days that had payments, oldest first. */
  readonly days: readonly EarningsDay[];
  /** One per range in EARNINGS_RANGES. */
  readonly payers: readonly PayerCount[];
  /** Newest first (failed attempts too), up to LATEST_PAYMENTS. */
  readonly latest: readonly RecentPayment[];
  /** The first day fully read: earlier ones aren't known (a busy account read only in part). */
  readonly from: string;
  /** When it was read (ms). */
  readonly at: number;
  /** More charges than Beluga reads in one go: the oldest days are missing some. */
  readonly partial?: boolean;
}

/** How many of the latest payments are kept. */
export const LATEST_PAYMENTS = 25;

/** A project's Stripe connection as screens see it. */
export interface ProjectEarnings {
  readonly connected: true;
  /** The Stripe account's display name (when the key may read it). */
  readonly account?: string;
  /** Test-mode or live key. */
  readonly mode: 'test' | 'live';
  /** A full secret key (sk_) rather than a restricted one (rk_): it works, but could do far more than read. */
  readonly secretKey?: boolean;
  /** Biggest first. Missing until the first count finishes. */
  readonly totals?: readonly MoneyTotal[];
  /** What it did lately (missing until it's first read). */
  readonly activity?: EarningsActivity;
  /** When the totals were last brought up to date. */
  readonly updatedAt?: number;
  readonly refreshing?: boolean;
  /** The last refresh failed (the totals, if any, are from before). */
  readonly error?: EarningsError;
}

/**
 * Exchange rates, roughly (the European Central Bank's, fetched once a day), to add up earnings in
 * several currencies: how many of each currency one US dollar buys. Lowercase codes.
 */
export interface FxRates {
  readonly rates: Readonly<Record<string, number>>;
  /** When they were fetched. */
  readonly at: number;
}

export interface EarningsSlice {
  /** By project folder (like the environment's names). */
  readonly earnings: Readonly<Record<string, ProjectEarnings>>;
  readonly fx?: FxRates;
}

export const initialEarnings: EarningsSlice = { earnings: {} };

export type EarningsAction =
  /** A project's Stripe connection changed (no `earnings`: disconnected). */
  | { type: 'earnings'; root: string; earnings?: ProjectEarnings }
  | { type: 'fx_rates'; fx: FxRates };

export function reduceEarnings(state: EarningsSlice, action: EarningsAction): EarningsSlice {
  if (action.type === 'fx_rates') return { ...state, fx: action.fx };
  if (action.earnings) return { ...state, earnings: { ...state.earnings, [action.root]: action.earnings } };
  if (!(action.root in state.earnings)) return state;
  const { [action.root]: _gone, ...rest } = state.earnings;
  return { ...state, earnings: rest };
}

/** A currency's smallest unit per whole unit (100 for USD, 1 for JPY). */
export function minorUnits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits;
    return 10 ** (digits ?? 2);
  } catch {
    return 100;
  }
}

/** Several totals as one currency: what could be added up, and what couldn't (no rate yet). */
export interface Converted {
  /** In `into`'s smallest unit: every total that could be converted. */
  readonly amount: number;
  /** Totals left out because a rate is missing (theirs or the target's). */
  readonly missing: readonly MoneyTotal[];
  /** Some total was in another currency (so the amount is approximate, at the rates). */
  readonly converted: boolean;
}

/** One unit of `currency` in dollars' terms: how many of it a dollar buys (1 for USD). */
const rateOf = (currency: string, fx: FxRates | undefined): number | undefined => {
  if (currency === 'usd') return 1;
  const rate = fx?.rates[currency];
  return rate && Number.isFinite(rate) && rate > 0 ? rate : undefined;
};

/**
 * Add up totals in `into` (smallest unit) at these rates, through dollars. Totals already in
 * `into` count exactly; a total whose currency has no rate is left out and listed in `missing`
 * (never NaN). Approximate on purpose: it's a glance, Stripe has the exact figures.
 */
export function convertParts(totals: readonly MoneyTotal[], into: string, fx: FxRates | undefined): Converted {
  const out = rateOf(into, fx);
  let exact = 0;
  let usd = 0;
  let converted = false;
  const missing: MoneyTotal[] = [];
  for (const t of totals) {
    if (t.currency === into) {
      exact += t.amount;
      continue;
    }
    const rate = rateOf(t.currency, fx);
    if (!rate || !out) {
      missing.push(t);
      continue;
    }
    usd += t.amount / minorUnits(t.currency) / rate;
    converted = true;
  }
  return { amount: exact + (out ? Math.round(usd * out * minorUnits(into)) : 0), missing, converted };
}

/** Several totals as one, in `into` (smallest unit), at these rates; undefined when a currency has no rate. */
export function convertTotals(totals: readonly MoneyTotal[], into: string, fx: FxRates | undefined): number | undefined {
  const parts = convertParts(totals, into, fx);
  return parts.missing.length ? undefined : parts.amount;
}

/**
 * The currency totals are shown in: the one the most money was earned in (converted to compare),
 * dollars when nothing is connected.
 */
export function mainCurrency(earnings: Readonly<Record<string, ProjectEarnings>>, fx: FxRates | undefined): string {
  const usd = new Map<string, number>();
  for (const e of Object.values(earnings)) {
    for (const t of e.totals ?? []) usd.set(t.currency, (usd.get(t.currency) ?? 0) + (convertTotals([t], 'usd', fx) ?? 0));
  }
  let best = 'usd';
  let most = -1;
  for (const [currency, value] of usd) if (value > most) [best, most] = [currency, value];
  return best;
}

/** A currency code as prefs keep it: three lowercase letters. */
export const CURRENCY_CODE = /^[a-z]{3}$/;

/**
 * The currency earnings are shown in: the one you chose ("Show earnings in"), else the one the
 * most money was earned in.
 */
export function earningsCurrency(chosen: string | undefined, earnings: Readonly<Record<string, ProjectEarnings>>, fx: FxRates | undefined): string {
  return chosen && CURRENCY_CODE.test(chosen) ? chosen : mainCurrency(earnings, fx);
}

/** Add up totals per currency (biggest first). */
export function sumTotals(lists: ReadonlyArray<readonly MoneyTotal[] | undefined>): MoneyTotal[] {
  const by = new Map<string, number>();
  for (const list of lists) for (const t of list ?? []) by.set(t.currency, (by.get(t.currency) ?? 0) + t.amount);
  return [...by].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);
}

// ---- recent earnings, by range

/** A day on this computer's calendar: "2026-10-25". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The `n` days ending `skip` days before the day of `now`, oldest first. */
export function lastDays(n: number, now: number, skip = 0): string[] {
  const d = new Date(now);
  // Noon, so a daylight-saving change never lands a day twice.
  return Array.from({ length: n }, (_, i) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - skip - (n - 1 - i), 12).getTime()));
}

/** When the first of the last `n` days began (ms), `skip` days further back. */
export function rangeStart(n: number, now: number, skip = 0): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - skip - (n - 1)).getTime();
}

export interface RangeDay {
  readonly day: string;
  readonly totals: readonly MoneyTotal[];
  readonly payments: number;
}

/** A range's money, payments and paying customers. */
export interface RangePart {
  readonly totals: readonly MoneyTotal[];
  readonly payments: number;
  readonly payers?: number;
}

export interface RangeFigures extends RangePart {
  readonly range: EarningsRange;
  /** Every day of the range, oldest first, ending today (the quiet ones too). */
  readonly days: readonly RangeDay[];
  /** The same span just before it, when Beluga read that far back. */
  readonly before?: RangePart;
}

/** The last `range` days of a project's activity, and the span before them to compare. */
export function rangeFigures(activity: EarningsActivity, range: EarningsRange, now: number = Date.now()): RangeFigures {
  const by = new Map(activity.days.map((d) => [d.day, d]));
  const pick = (keys: readonly string[]): RangeDay[] => keys.map((day) => ({ day, totals: by.get(day)?.totals ?? [], payments: by.get(day)?.payments ?? 0 }));
  const part = (list: readonly RangeDay[], payers: number | undefined): RangePart => ({
    totals: sumTotals(list.map((d) => d.totals)),
    payments: list.reduce((n, d) => n + d.payments, 0),
    ...(payers !== undefined ? { payers } : {}),
  });
  const days = pick(lastDays(range, now));
  const earlier = lastDays(range, now, range);
  const payers = activity.payers.find((p) => p.days === range);
  // "2026-…" strings sort as days do.
  const reaches = earlier[0]! >= activity.from;
  return { range, days, ...part(days, payers?.now), ...(reaches ? { before: part(pick(earlier), payers?.before) } : {}) };
}

/** Offered first when choosing a currency; the rest follow alphabetically. */
export const COMMON_CURRENCIES: readonly string[] = ['usd', 'eur', 'gbp', 'try', 'inr', 'jpy', 'cad', 'aud', 'chf', 'cny'];

/**
 * The currencies earnings can be shown in: the ones the rates cover (dollars always), the common
 * ones first, plus `keep` (your current choice) even if its rate went missing.
 */
export function currencyChoices(fx: FxRates | undefined, keep?: string): string[] {
  const covered = new Set(['usd', ...Object.keys(fx?.rates ?? {}).filter((c) => CURRENCY_CODE.test(c))]);
  if (keep && CURRENCY_CODE.test(keep)) covered.add(keep);
  const common = COMMON_CURRENCIES.filter((c) => covered.has(c));
  const rest = [...covered].filter((c) => !COMMON_CURRENCIES.includes(c)).sort();
  return [...common, ...rest];
}
