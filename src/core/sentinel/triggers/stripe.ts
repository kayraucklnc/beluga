import type { StripeTrigger } from '../model.js';
import { MINUTE, type FetchLike, type TriggerContext, type TriggerDeps, type TriggerEvent, clip, isObj, num, remember, startPolling, str } from './types.js';

/**
 * Stripe (docs/sentinel.md §1): the project's account (its key from Earnings), its events polled
 * every 2 minutes. The cursor is the newest event's time (Stripe's seconds) and the ids seen at it,
 * so `created[gte]` reads only what's new and nothing fires twice. The payload is a summary of
 * the event (amount, currency, the customer's email, the description, the event's id and type):
 * never card details.
 */

export interface StripeCursor {
  /** The newest event's `created` (seconds). */
  readonly at: number;
  readonly seen: readonly string[];
}

export const STRIPE_TYPES: Readonly<Record<StripeTrigger['what'], readonly string[]>> = {
  'payment-failed': ['payment_intent.payment_failed', 'invoice.payment_failed'],
  'subscription-started': ['customer.subscription.created'],
  'subscription-ended': ['customer.subscription.deleted'],
  'dispute-opened': ['charge.dispute.created'],
  refund: ['charge.refunded'],
};

const WORDS: Readonly<Record<StripeTrigger['what'], string>> = {
  'payment-failed': 'payment failed',
  'subscription-started': 'subscription started',
  'subscription-ended': 'subscription ended',
  'dispute-opened': 'dispute opened',
  refund: 'refund',
};

const STRIPE_API = 'https://api.stripe.com';
export const STRIPE_EVERY_MS = 2 * MINUTE;
export const NO_STRIPE = 'Connect Stripe in Earnings first';

/** Currencies Stripe counts in whole units (no cents). */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

/** 4200 usd → "$42.00". */
export function moneyText(amount: number, currency: string): string {
  const cur = currency.toLowerCase();
  const value = ZERO_DECIMAL.has(cur) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(value);
  } catch {
    return `${value.toFixed(ZERO_DECIMAL.has(cur) ? 0 : 2)} ${cur.toUpperCase()}`;
  }
}

/** A Stripe event as a summary: what the run needs, never a card number, never the raw object. */
export function stripeEvent(what: StripeTrigger['what'], e: Record<string, unknown>): TriggerEvent {
  const o = isObj(e.data) && isObj(e.data.object) ? e.data.object : {};
  const type = str(e.type) ?? '';
  const currency = str(o.currency) ?? '';
  let amount: number | undefined;
  let email: string | undefined;
  let reason: string | undefined;
  let interval: string | undefined;
  if (type.startsWith('payment_intent.')) {
    amount = num(o.amount);
    email = str(o.receipt_email);
    reason = isObj(o.last_payment_error) ? str(o.last_payment_error.message) : undefined;
  } else if (type.startsWith('invoice.')) {
    amount = num(o.amount_due);
    email = str(o.customer_email);
    reason = isObj(o.last_finalization_error) ? str(o.last_finalization_error.message) : undefined;
  } else if (type.startsWith('customer.subscription.')) {
    const item = isObj(o.items) && Array.isArray(o.items.data) && isObj(o.items.data[0]) ? o.items.data[0] : undefined;
    const price = item && isObj(item.price) ? item.price : undefined;
    amount = price ? num(price.unit_amount) : undefined;
    interval = price && isObj(price.recurring) ? str(price.recurring.interval) : undefined;
    reason = isObj(o.cancellation_details) ? str(o.cancellation_details.reason) : undefined;
  } else if (type.startsWith('charge.dispute.')) {
    amount = num(o.amount);
    reason = str(o.reason);
  } else if (type === 'charge.refunded') {
    amount = num(o.amount_refunded);
    email = str(o.receipt_email) ?? (isObj(o.billing_details) ? str(o.billing_details.email) : undefined);
  }
  const cur = currency || price(o) || '';
  const money = amount !== undefined && cur ? `${moneyText(amount, cur)}${interval ? `/${interval}` : ''}` : undefined;
  const customer = typeof o.customer === 'string' ? o.customer : isObj(o.customer) ? str(o.customer.id) : undefined;
  return {
    summary: clip(`Stripe: ${WORDS[what]}${money ? `, ${money}` : ''}`, 120),
    payload: {
      id: str(e.id),
      type,
      livemode: e.livemode === true,
      ...(amount !== undefined ? { amount } : {}),
      ...(cur ? { currency: cur } : {}),
      ...(money ? { amountText: money } : {}),
      ...(email ? { email } : {}),
      ...(customer ? { customer } : {}),
      ...(str(o.description) ? { description: clip(str(o.description)!, 300) } : {}),
      ...(reason ? { reason: clip(reason, 300) } : {}),
      ...(str(o.id) ? { object: str(o.id) } : {}),
    },
  };
}

/** A subscription's currency lives on its price. */
function price(o: Record<string, unknown>): string | undefined {
  const item = isObj(o.items) && Array.isArray(o.items.data) && isObj(o.items.data[0]) ? o.items.data[0] : undefined;
  return item && isObj(item.price) ? str(item.price.currency) : undefined;
}

class StripeTrouble extends Error {}

async function getEvents(fetchFn: FetchLike, key: string, query: string, base: string): Promise<Record<string, unknown>[]> {
  const res = await fetchFn(`${base}/v1/events?${query}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) throw new StripeTrouble('Stripe doesn’t accept the project’s key anymore: connect it again in Earnings');
  if (res.status === 403) throw new StripeTrouble('The project’s Stripe key can’t read events: give it Events: Read in Stripe, then connect it again in Earnings');
  if (res.status >= 400) throw new Error(`Stripe answered ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await res.text()) as unknown;
  } catch {
    throw new Error('Stripe gave an answer Beluga doesn’t understand');
  }
  return isObj(body) && Array.isArray(body.data) ? body.data.filter(isObj) : [];
}

/** One look: new events oldest first, and the cursor moved. The first look only notes the newest. */
export async function lookStripe(t: StripeTrigger, key: string, cursor: StripeCursor | undefined, fetchFn: FetchLike, now: number, base = STRIPE_API): Promise<{ readonly events: TriggerEvent[]; readonly cursor: StripeCursor }> {
  const types = STRIPE_TYPES[t.what];
  const q = new URLSearchParams({ limit: cursor ? '100' : '1' });
  for (const ty of types) q.append('types[]', ty);
  if (cursor) q.set('created[gte]', String(cursor.at));
  const found = await getEvents(fetchFn, key, q.toString(), base);
  if (!cursor) {
    const top = found[0];
    return { events: [], cursor: { at: num(top?.created) ?? Math.floor(now / 1000), seen: top && str(top.id) ? [str(top.id)!] : [] } };
  }
  const seen = new Set(cursor.seen);
  const fresh = found.filter((e) => str(e.id) && !seen.has(str(e.id)!) && (num(e.created) ?? 0) >= cursor.at && types.includes(str(e.type) ?? '')).sort((a, b) => (num(a.created) ?? 0) - (num(b.created) ?? 0));
  const at = fresh.reduce((m, e) => Math.max(m, num(e.created) ?? 0), cursor.at);
  // Ids at the newest second stay seen (the next look asks from that second again).
  const keep = at === cursor.at ? cursor.seen : [];
  return { events: fresh.map((e) => stripeEvent(t.what, e)), cursor: { at, seen: remember(keep, fresh.filter((e) => num(e.created) === at).map((e) => str(e.id)!), 200) } };
}

export function startStripe(t: StripeTrigger, ctx: TriggerContext<StripeCursor>, deps: TriggerDeps, base = STRIPE_API): () => void {
  const now = deps.now ?? Date.now;
  return startPolling(
    ctx,
    async () => {
      const projectId = ctx.sentinel.projectId;
      if (!projectId) return 'Pick the project whose Stripe this watches (Project, on the right)';
      const key = deps.stripeKey?.(projectId);
      if (!key || !deps.fetch) return NO_STRIPE;
      try {
        const { events, cursor } = await lookStripe(t, key, ctx.cursor(), deps.fetch, now(), base);
        ctx.save(cursor);
        for (const e of events) ctx.fire(e);
        return undefined;
      } catch (err) {
        if (err instanceof StripeTrouble) return err.message;
        throw err;
      }
    },
    { everyMs: STRIPE_EVERY_MS, failing: 'Stripe didn’t answer' },
  );
}
