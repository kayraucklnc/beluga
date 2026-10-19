import { type Converted, type FxRates, type MoneyTotal, convertParts } from '../../../../src/core/earnings-store.js';

/**
 * Money for people, without React: formatting amounts (a glance or exact), naming currencies,
 * how fresh the exchange rates are, and earnings added up in the one currency you show them in.
 * Pure, so the tests run it (tests/earnings-fx.test.ts).
 */

/** Digits after the point for a currency (2 for USD, 0 for JPY, 3 for KWD). */
function exponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const displays = new Map<string, 'symbol' | 'narrowSymbol'>();
/**
 * The currency's symbol: the usual one ("$", "€", "CA$"), or the narrow one when the usual is just
 * the code ("₺" rather than "TRY 14,255.00").
 */
function display(code: string): 'symbol' | 'narrowSymbol' {
  let known = displays.get(code);
  if (!known) {
    try {
      known = new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(1).includes(code) ? 'narrowSymbol' : 'symbol';
    } catch {
      known = 'symbol';
    }
    displays.set(code, known);
  }
  return known;
}

/**
 * An amount in a currency's smallest unit, for people: "$12,480.50", or compact for the
 * sidebar ("$12.5K", "$840", "€1.2M").
 */
export function formatMoney(amount: number, currency: string, compact = false): string {
  const code = currency.toUpperCase();
  const value = amount / 10 ** exponent(code);
  try {
    const currencyDisplay = display(code);
    if (compact) {
      const small = Math.abs(value) < 1000;
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay, notation: small ? 'standard' : 'compact', maximumFractionDigits: small ? 0 : 1 }).format(value);
    }
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay }).format(value);
  } catch {
    return `${value.toFixed(compact ? 0 : 2)} ${code}`;
  }
}

/**
 * An amount at a glance, for big figures and rows: exact up to 10,000 ("$5,812", "$84.50"),
 * compact above ("₺214.6K", "$1.2M"). The exact amount belongs in a tooltip.
 */
export function formatGlance(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const value = Math.abs(amount / 10 ** exponent(code));
  if (value >= 10_000) return formatMoney(amount, currency, true);
  if (value >= 1000) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, currencyDisplay: display(code), maximumFractionDigits: 0 }).format(amount / 10 ** exponent(code));
    } catch {
      return formatMoney(amount, currency);
    }
  }
  return formatMoney(amount, currency);
}

/** "USD — US Dollar" for menus (the code alone when the system doesn't know the name). */
export function currencyName(currency: string): string {
  const code = currency.toUpperCase();
  try {
    const name = new Intl.DisplayNames(undefined, { type: 'currency' }).of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

/** How fresh the rates are: "today", "yesterday", "on Oct 12". */
export function ratesWhen(at: number, now: number = Date.now()): string {
  const day = (t: number): string => new Date(t).toDateString();
  if (day(at) === day(now)) return 'today';
  if (day(at) === day(now - 86_400_000)) return 'yesterday';
  return `on ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** "₹269 not included (no rate yet)", for totals that couldn't be converted. */
export function missingNote(missing: readonly MoneyTotal[]): string | undefined {
  if (!missing.length) return undefined;
  return `${missing.map((t) => formatGlance(t.amount, t.currency)).join(', ')} not included (no rate yet)`;
}

/** One project's earnings, in the currency you show them in. */
export interface ConvertedRow<T> {
  readonly item: T;
  readonly money: Converted;
  /** Its part of everything (0–1). */
  readonly share: number;
}

/** Every connected project's earnings in one currency: the total, and each project's part of it. */
export interface ConvertedSummary<T> {
  readonly currency: string;
  readonly total: Converted;
  /** The biggest first. */
  readonly rows: readonly ConvertedRow<T>[];
}

/** Add every project's totals up in `currency` (each row converted on its own, so the parts add up to the whole). */
export function convertSummary<T>(items: readonly T[], totalsOf: (item: T) => readonly MoneyTotal[] | undefined, currency: string, fx: FxRates | undefined): ConvertedSummary<T> {
  const converted = items.map((item) => ({ item, money: convertParts(totalsOf(item) ?? [], currency, fx) }));
  const amount = converted.reduce((sum, r) => sum + r.money.amount, 0);
  const missing = new Map<string, number>();
  for (const r of converted) for (const t of r.money.missing) missing.set(t.currency, (missing.get(t.currency) ?? 0) + t.amount);
  const rows = converted.map((r) => ({ ...r, share: amount > 0 ? Math.max(0, r.money.amount) / amount : 0 })).sort((a, b) => b.money.amount - a.money.amount);
  return {
    currency,
    total: { amount, missing: [...missing].map(([c, a]) => ({ currency: c, amount: a })), converted: converted.some((r) => r.money.converted) },
    rows,
  };
}
