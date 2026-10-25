/**
 * What a project did lately, from its recent charges (stripe-client.ts reads them): earned per
 * day, distinct paying customers per range (and in the span before, to compare), and the latest
 * payments. Screens get a first name or a masked email for who paid, never more.
 */
import { ACTIVITY_DAYS, EARNINGS_RANGES, type EarningsActivity, type EarningsDay, LATEST_PAYMENTS, type PaymentStatus, type RecentPayment, dayKey, rangeStart, sumTotals } from './earnings-store.js';
import { type Charge, chargeNet } from './stripe-client.js';

/** When the recent read starts (seconds): the first of the last ACTIVITY_DAYS days. */
export const activitySince = (now: number): number => Math.floor(rangeStart(ACTIVITY_DAYS, now) / 1000);

/** Who paid, to count each paying customer once: their customer, else their email, else their card. */
function payerOf(c: Charge): string {
  const customer = typeof c.customer === 'string' ? c.customer : c.customer?.id;
  const email = (c.billing_details?.email ?? c.receipt_email ?? '').trim().toLowerCase();
  return customer || (email ? `email:${email}` : '') || (c.payment_method_details?.card?.fingerprint ? `card:${c.payment_method_details.card.fingerprint}` : '') || `charge:${c.id}`;
}

/** "Maya Kaya" → "Maya K."; one word stays as it is. */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return (words[0] ?? '').slice(0, 24);
  return `${words[0]!.slice(0, 24)} ${words[words.length - 1]![0]!.toUpperCase()}.`;
}

/** "maya@example.com" → "m•••@example.com". */
export function maskEmail(email: string): string | undefined {
  const at = email.trim().lastIndexOf('@');
  if (at < 1) return undefined;
  const e = email.trim();
  return `${e[0]}•••${e.slice(at)}`.slice(0, 60);
}

function statusOf(c: Charge): PaymentStatus {
  if (c.status === 'failed' || (c.paid === false && c.status !== 'pending')) return 'failed';
  if (c.status !== 'succeeded' || c.captured === false) return 'pending';
  const refunded = c.amount_refunded ?? 0;
  if (refunded <= 0) return 'paid';
  return chargeNet(c) > 0 ? 'partly_refunded' : 'refunded';
}

function paymentOf(c: Charge): RecentPayment {
  const name = c.billing_details?.name?.trim();
  const email = c.billing_details?.email ?? c.receipt_email ?? undefined;
  const who = name ? shortName(name) : email ? maskEmail(email) : undefined;
  const description = c.description?.trim().replace(/\s+/g, ' ').slice(0, 80);
  const refunded = c.amount_refunded ?? 0;
  return {
    id: c.id,
    at: c.created * 1000,
    amount: c.amount,
    currency: c.currency.toLowerCase(),
    ...(refunded > 0 ? { refunded } : {}),
    status: statusOf(c),
    ...(who ? { who } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Sum up recent charges (newest first, as Stripe lists them) as of `now` (ms). `partial`: the
 * read stopped before reaching ACTIVITY_DAYS back, so only the days after the oldest charge
 * read are known.
 */
export function summarizeActivity(charges: readonly Charge[], now: number, partial = false): EarningsActivity {
  const byDay = new Map<string, { totals: Array<{ currency: string; amount: number }>; payments: number }>();
  for (const c of charges) {
    const net = chargeNet(c);
    if (net <= 0) continue;
    const day = dayKey(c.created * 1000);
    const entry = byDay.get(day) ?? { totals: [], payments: 0 };
    entry.totals.push({ currency: c.currency.toLowerCase(), amount: net });
    entry.payments++;
    byDay.set(day, entry);
  }
  const days: EarningsDay[] = [...byDay]
    .map(([day, e]) => ({ day, totals: sumTotals([e.totals]), payments: e.payments }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const paying = charges.filter((c) => chargeNet(c) > 0);
  const payers = EARNINGS_RANGES.map((range) => {
    const start = rangeStart(range, now) / 1000;
    const earlier = rangeStart(range, now, range) / 1000;
    const nowSet = new Set<string>();
    const beforeSet = new Set<string>();
    for (const c of paying) {
      if (c.created >= start) nowSet.add(payerOf(c));
      else if (c.created >= earlier) beforeSet.add(payerOf(c));
    }
    return { days: range, now: nowSet.size, before: beforeSet.size };
  });

  // A partial read only knows the days after its oldest charge (that one's day may be missing some).
  const oldest = charges[charges.length - 1];
  const from = partial && oldest ? dayKey((oldest.created + 86_400) * 1000) : dayKey(rangeStart(ACTIVITY_DAYS, now));
  return {
    days,
    payers,
    latest: charges.slice(0, LATEST_PAYMENTS).map(paymentOf),
    from,
    at: now,
    ...(partial ? { partial } : {}),
  };
}
