import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type FxRates, type MoneyTotal, type ProjectEarnings, type RecentPayment, convertParts, currencyChoices, earningsCurrency, mainCurrency, sumTotals } from '@beluga/core/earnings-store.js';
import type { Project } from '@beluga/workspaces/types.js';
import { type ConvertedSummary, convertSummary, currencyName } from './money.js';
import { useApi, useApp } from './beluga.js';

/**
 * Earnings from Stripe in this window: the currency they're shown in (yours, or the one most was
 * earned in), the projects that have Stripe connected (useEarnings, for the Overview and the
 * Usage view), the Connect Stripe sheet, and the one-time hint that tells you it exists. The
 * counting is the core's (core/stripe-earnings.ts); the keys never come here.
 */

export type { MoneyTotal, ProjectEarnings, RecentPayment };
export { mainCurrency, sumTotals };
export { formatGlance, formatMoney, missingNote, ratesWhen } from './money.js';

/** The currency earnings are shown in, today's rates, and whether you chose it (undefined: automatic). */
export interface Money {
  readonly currency: string;
  readonly fx: FxRates | undefined;
  readonly chosen: string | undefined;
}

export function useMoney(): Money {
  const earnings = useApp((st) => st.earnings);
  const fx = useApp((st) => st.fx);
  const chosen = useApp((st) => st.prefs.earningsCurrency);
  return useMemo(() => ({ currency: earningsCurrency(chosen, earnings, fx), fx, chosen }), [earnings, fx, chosen]);
}

/** A project's totals in the currency earnings are shown in (what converts, and what has no rate yet). */
export const useConverted = (totals: readonly MoneyTotal[] | undefined): ReturnType<typeof convertParts> & { currency: string } => {
  const { currency, fx } = useMoney();
  return { ...convertParts(totals ?? [], currency, fx), currency };
};

/** The "Show earnings in" choice: "" is automatic. */
export const AUTOMATIC = '';

/**
 * "Show earnings in": its options (Automatic, then the currencies the rates cover, common ones
 * first), its value, and setting it (saved in ~/.beluga/settings.json, for every window).
 */
export function useCurrencyChoice(): { value: string; options: Array<{ value: string; label: string; short?: string }>; onChange: (v: string) => void } {
  const api = useApi();
  const earnings = useApp((st) => st.earnings);
  const { fx, chosen } = useMoney();
  const auto = mainCurrency(earnings, fx);
  const options = useMemo(
    () => [
      { value: AUTOMATIC, label: `Automatic (${auto.toUpperCase()})`, short: `Automatic (${auto.toUpperCase()})` },
      ...currencyChoices(fx, chosen).map((c) => ({ value: c, label: currencyName(c), short: c.toUpperCase() })),
    ],
    [auto, fx, chosen],
  );
  return { value: chosen ?? AUTOMATIC, options, onChange: (v) => void api.session.setPrefs({ earningsCurrency: v === AUTOMATIC ? null : v }) };
}

/** "just now", "12 min ago", "3h ago", "2 days ago". */
export function updatedAgo(ts: number | undefined, now: number = Date.now()): string {
  if (!ts) return 'not counted yet';
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** One project's Stripe connection (undefined: not connected). */
export function useProjectEarnings(root: string | undefined): ProjectEarnings | undefined {
  return useApp((st) => (root ? st.earnings[root] : undefined));
}

export interface ConnectedProject {
  readonly project: Project;
  readonly earnings: ProjectEarnings;
}

export interface EarningsSummary {
  /** Projects with Stripe connected, the biggest earner first. */
  readonly projects: readonly ConnectedProject[];
  /** Every connected project together, per currency (biggest first). */
  readonly totals: readonly MoneyTotal[];
  /** Some project is being counted right now. */
  readonly refreshing: boolean;
  /** When the oldest count was brought up to date. */
  readonly updatedAt?: number;
}

export function summarize(projects: readonly Project[], earnings: Readonly<Record<string, ProjectEarnings>>, fx?: FxRates): EarningsSummary {
  const connected = projects.flatMap((project) => (project.root && earnings[project.root] ? [{ project, earnings: earnings[project.root]! }] : []));
  // Compared in dollars, so lira and yen don't outweigh dollars by their size.
  const main = (e: ProjectEarnings): number => (e.totals ? convertParts(e.totals, 'usd', fx).amount : -1);
  const sorted = [...connected].sort((a, b) => main(b.earnings) - main(a.earnings));
  const times = connected.map((c) => c.earnings.updatedAt).filter((t): t is number => t !== undefined);
  return {
    projects: sorted,
    totals: sumTotals(connected.map((c) => c.earnings.totals)),
    refreshing: connected.some((c) => c.earnings.refreshing),
    ...(times.length ? { updatedAt: Math.min(...times) } : {}),
  };
}

/**
 * Every project with Stripe connected and what they earned together (for the Overview's card
 * and the Usage view). Re-renders only when projects or earnings change.
 */
export function useEarnings(): EarningsSummary {
  const projects = useApp((st) => st.projects);
  const earnings = useApp((st) => st.earnings);
  const fx = useApp((st) => st.fx);
  return useMemo(() => summarize(projects, earnings, fx), [projects, earnings, fx]);
}

/** Every connected project's earnings added up in the currency they're shown in, each project's part of it. */
export function useConvertedEarnings(): EarningsSummary & { converted: ConvertedSummary<ConnectedProject>; fx: FxRates | undefined } {
  const summary = useEarnings();
  const { currency, fx } = useMoney();
  const converted = useMemo(() => convertSummary(summary.projects, (c) => c.earnings.totals, currency, fx), [summary.projects, currency, fx]);
  return { ...summary, converted, fx };
}

// ---- new payments

/** The newest payment that went through (a new one arriving changes it). */
export const newestPaid = (e: ProjectEarnings | undefined): RecentPayment | undefined => e?.activity?.latest.find((p) => p.status === 'paid' || p.status === 'partly_refunded');

/**
 * Counts up each time a new payment arrives while this is shown: never on first show, when
 * Stripe is first connected, or when the currency or the rates change (only the payments do).
 */
export function usePaymentArrivals(earnings: ProjectEarnings | undefined): number {
  const newest = newestPaid(earnings);
  const last = useRef(newest);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const was = last.current;
    if (newest?.id === was?.id) return;
    last.current = newest;
    // A refund can make an older payment the newest: that's no new payment.
    if (was && newest && newest.at > was.at) setCount((n) => n + 1);
  }, [newest?.id]);
  return count;
}

/** The ids of the payments that arrived while this was shown (marked New). */
export function useArrived(latest: readonly RecentPayment[] | undefined): ReadonlySet<string> {
  const first = useRef<ReadonlySet<string> | undefined>(undefined);
  if (!first.current && latest) first.current = new Set(latest.map((p) => p.id));
  return useMemo(() => new Set((latest ?? []).filter((p) => first.current && !first.current.has(p.id)).map((p) => p.id)), [latest]);
}

/** Stripe's own list of payments (test mode has its own). */
export const stripePaymentsUrl = (mode: 'test' | 'live'): string => `https://dashboard.stripe.com/${mode === 'test' ? 'test/' : ''}payments`;

// ---- the Connect Stripe sheet (one at a time; projectId unset: pick the project in the sheet)

export interface StripeSheetState {
  readonly projectId?: string;
}

let sheet: StripeSheetState | undefined;
const sheetListeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...sheetListeners]) l();
};

export function openStripe(projectId?: string): void {
  sheet = projectId ? { projectId } : {};
  emit();
}

export function closeStripe(): void {
  if (!sheet) return;
  sheet = undefined;
  emit();
}

export const useStripeSheet = (): StripeSheetState | undefined =>
  useSyncExternalStore(
    (l) => {
      sheetListeners.add(l);
      return () => void sheetListeners.delete(l);
    },
    () => sheet,
  );

/** "Connect Stripe…" for a project's right-click and ⋯ menus ("Stripe Earnings…" once connected). */
export function stripeMenuItem(project: Project, connected: boolean): { label: string; onSelect: () => void; separate: boolean } {
  return { label: connected ? 'Stripe Earnings…' : 'Connect Stripe…', onSelect: () => openStripe(project.id), separate: true };
}

// ---- the one-time hint ("Track this project's earnings")

const HINT_KEY = 'beluga.earnings.hint.v1';
let hintDismissed = ((): boolean => {
  try {
    return localStorage.getItem(HINT_KEY) === 'dismissed';
  } catch {
    return false;
  }
})();
const hintListeners = new Set<() => void>();

export function dismissEarningsHint(): void {
  hintDismissed = true;
  try {
    localStorage.setItem(HINT_KEY, 'dismissed');
  } catch {
    // storage unavailable: hidden until the app quits
  }
  for (const l of [...hintListeners]) l();
}

export const useEarningsHintDismissed = (): boolean =>
  useSyncExternalStore(
    (l) => {
      hintListeners.add(l);
      return () => void hintListeners.delete(l);
    },
    () => hintDismissed,
  );

/** Where to create a key that can only read charges (and, optionally, the account's name). */
export const STRIPE_KEY_URL = 'https://dashboard.stripe.com/apikeys/create?name=Beluga&permissions%5B%5D=rak_charge_read&permissions%5B%5D=rak_connected_account_read';

/** Test or live, and whether it's a full secret key, from what was typed (before asking Stripe). */
export function keyKind(key: string): { mode?: 'test' | 'live'; secret: boolean; publishable: boolean } {
  const k = key.trim();
  return { ...(/^(rk|sk)_live_/.test(k) ? { mode: 'live' as const } : /^(rk|sk)_test_/.test(k) ? { mode: 'test' as const } : {}), secret: k.startsWith('sk_'), publishable: k.startsWith('pk_') };
}
