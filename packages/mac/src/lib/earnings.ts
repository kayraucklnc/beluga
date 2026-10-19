import { useMemo, useSyncExternalStore } from 'react';
import { type FxRates, type MoneyTotal, type ProjectEarnings, convertTotals, mainCurrency } from '@klaud/core/earnings-store.js';
import type { Project } from '@klaud/workspaces/types.js';
import { brandText } from './brand.js';
import { useApp } from './klaud.js';

/**
 * Earnings from Stripe in this window: formatting money, the projects that have Stripe
 * connected (useEarnings, for the Overview and the Usage view), the Connect Stripe sheet,
 * and the one-time hint that tells you it exists. The counting is the core's
 * (core/stripe-earnings.ts); the keys never come here.
 */

export type { MoneyTotal, ProjectEarnings };
export { mainCurrency };

/** A project's earnings as one amount in `currency` (approximate across currencies), or undefined without rates. */
export const combinedTotal = (totals: readonly MoneyTotal[], currency: string, fx: FxRates | undefined): number | undefined => (totals.length ? convertTotals(totals, currency, fx) : undefined);

/** The main currency and today's rates, for screens. */
export function useMoney(): { currency: string; fx: FxRates | undefined } {
  const earnings = useApp((st) => st.earnings);
  const fx = useApp((st) => st.fx);
  return { currency: mainCurrency(earnings, fx), fx };
}

/** Digits after the point for a currency (2 for USD, 0 for JPY, 3 for KWD). */
function exponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * An amount in a currency's smallest unit, for people: "$12,480.50", or compact for the
 * sidebar ("$12.5K", "$840", "€1.2M").
 */
export function formatMoney(amount: number, currency: string, compact = false): string {
  const code = currency.toUpperCase();
  const value = amount / 10 ** exponent(code);
  try {
    if (compact) {
      const small = Math.abs(value) < 1000;
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, notation: small ? 'standard' : 'compact', maximumFractionDigits: small ? 0 : 1 }).format(value);
    }
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(compact ? 0 : 2)} ${code}`;
  }
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

/** Add up totals per currency (biggest first). */
export function sumTotals(lists: ReadonlyArray<readonly MoneyTotal[] | undefined>): MoneyTotal[] {
  const by = new Map<string, number>();
  for (const list of lists) for (const t of list ?? []) by.set(t.currency, (by.get(t.currency) ?? 0) + t.amount);
  return [...by].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount);
}

export function summarize(projects: readonly Project[], earnings: Readonly<Record<string, ProjectEarnings>>): EarningsSummary {
  const connected = projects.flatMap((project) => (project.root && earnings[project.root] ? [{ project, earnings: earnings[project.root]! }] : []));
  const main = (e: ProjectEarnings): number => e.totals?.[0]?.amount ?? -1;
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
  return useMemo(() => summarize(projects, earnings), [projects, earnings]);
}

/** What the pill's tooltip says: "All-time earnings · updated 3h ago", and every currency when there are several. */
export function earningsTip(e: ProjectEarnings, now: number = Date.now()): string {
  if (e.refreshing && !e.totals) return 'Counting all-time earnings from Stripe…';
  const head = `All-time earnings · ${e.refreshing ? 'updating…' : `updated ${updatedAgo(e.updatedAt, now)}`}`;
  const lines = (e.totals ?? []).length > 1 ? (e.totals ?? []).map((t) => formatMoney(t.amount, t.currency)) : [];
  return [head, ...lines, ...(e.error ? [brandText(e.error.message)] : [])].join('\n');
}

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

const HINT_KEY = 'klaud.earnings.hint.v1';
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
export const STRIPE_KEY_URL = 'https://dashboard.stripe.com/apikeys/create?name=klaud&permissions%5B%5D=rak_charge_read&permissions%5B%5D=rak_connected_account_read';

/** Test or live, and whether it's a full secret key, from what was typed (before asking Stripe). */
export function keyKind(key: string): { mode?: 'test' | 'live'; secret: boolean; publishable: boolean } {
  const k = key.trim();
  return { ...(/^(rk|sk)_live_/.test(k) ? { mode: 'live' as const } : /^(rk|sk)_test_/.test(k) ? { mode: 'test' as const } : {}), secret: k.startsWith('sk_'), publishable: k.startsWith('pk_') };
}
