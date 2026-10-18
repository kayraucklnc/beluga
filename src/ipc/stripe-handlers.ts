import type { Session } from '../core/session.js';
import { earningsOf } from '../core/stripe-earnings.js';
import type { Args, Method } from './api.js';

/** What each `stripe.*` method does (see stripe-api.ts). Results never carry the key. */

type StripeMethod = Extract<Method, `stripe.${string}`>;
type StripeHandlers = { readonly [M in StripeMethod]: (s: Session, ...args: Args<M>) => unknown };

/**
 * Connecting answers `{ ok: true, account?, mode, secretKey }`, or `{ ok: false, error }` when
 * the key won't do (the sheet shows why, next to the field, rather than a call failing).
 */
async function connect(s: Session, projectId: string, key: string): Promise<{ ok: true; account?: string; mode: 'test' | 'live'; secretKey: boolean } | { ok: false; error: string }> {
  const service = earningsOf(s);
  try {
    return { ok: true, ...(await service.connect(projectId, key)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const STRIPE_HANDLERS = {
  'stripe.connect': (s, projectId, key) => connect(s, projectId, key),
  'stripe.disconnect': (s, projectId) => earningsOf(s).disconnect(projectId),
  'stripe.refresh': (s, projectId) => earningsOf(s).refresh(projectId),
} satisfies StripeHandlers;
