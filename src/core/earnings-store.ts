/**
 * What each project earned, from its Stripe account, in the shared state: whether Stripe is
 * connected, the account's name, all-time totals per currency, when they were counted, and
 * what went wrong. Never the key itself (that stays in ~/.klaud/stripe.json, see
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
