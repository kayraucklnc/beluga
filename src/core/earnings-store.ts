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

export interface EarningsSlice {
  /** By project folder (like the environment's names). */
  readonly earnings: Readonly<Record<string, ProjectEarnings>>;
}

export const initialEarnings: EarningsSlice = { earnings: {} };

export type EarningsAction =
  /** A project's Stripe connection changed (no `earnings`: disconnected). */
  { type: 'earnings'; root: string; earnings?: ProjectEarnings };

export function reduceEarnings(state: EarningsSlice, action: EarningsAction): EarningsSlice {
  if (action.earnings) return { earnings: { ...state.earnings, [action.root]: action.earnings } };
  if (!(action.root in state.earnings)) return state;
  const { [action.root]: _gone, ...rest } = state.earnings;
  return { earnings: rest };
}
