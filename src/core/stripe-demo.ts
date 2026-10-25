import type { FetchLike } from './stripe-client.js';

/**
 * A pretend Stripe for the demo (and the Mac app's end-to-end tests): it answers the three
 * calls Beluga makes with made-up charges and refunds, so the earnings show without a real
 * key and nothing leaves the computer. Sales grow over the year, made-up customers come back,
 * and while the demo runs a new payment arrives every few minutes. Keys with "revoked" in them
 * are refused, keys with "nocharges" may not read charges, keys with "noaccount" may not read
 * the account.
 */

interface FakeCharge {
  readonly id: string;
  readonly object: 'charge';
  readonly created: number;
  readonly currency: string;
  readonly amount: number;
  readonly amount_captured: number;
  readonly amount_refunded: number;
  readonly captured: boolean;
  readonly paid: boolean;
  readonly status: 'succeeded' | 'failed';
  readonly customer: string;
  readonly billing_details: { readonly name: string; readonly email: string };
  readonly description: string;
}

const DAY = 86_400;
/** How many charges came before the demo started, over about the last ten months. */
const PAST = 420;
const SPAN_DAYS = 300;
/** While the demo runs, a new payment every this many seconds (unless told otherwise). */
export const DEMO_PAYMENT_EVERY = 180;

const FIRST = ['Maya', 'Leo', 'Ana', 'Jon', 'Priya', 'Sam', 'Elif', 'Noah', 'Mia', 'Kenji', 'Zoe', 'Omar', 'Lena', 'Ravi', 'Ines', 'Theo', 'Aylin', 'Hugo', 'Sara', 'Ben'];
const LAST = ['Kaya', 'Martin', 'Silva', 'Park', 'Shah', 'Lee', 'Demir', 'Brown', 'Rossi', 'Ito', 'Adams', 'Haddad', 'Vogel', 'Patel', 'Costa', 'Dubois', 'Yilmaz'];
const PLANS = ['Pro plan · monthly', 'Pro plan · monthly', 'Starter plan', 'Team plan', 'API credits', 'Pro plan · yearly'];
/** Made-up customers: a few come back again and again. */
const CUSTOMERS = 90;

/** Steady made-up numbers per key (the same key always shows the same earnings). */
function seeded(text: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 2 ** 32;
  };
}

/**
 * Which currencies a key's shop sells in, and how big a sale is in each (smallest units): most
 * in dollars, some in euros; keys with "Lira" in them sell in Turkish lira, some in rupees.
 */
function currenciesFor(key: string): { main: string; other: string; scale: number; otherScale: number } {
  return key.includes('Lira') ? { main: 'try', other: 'inr', scale: 30, otherScale: 40 } : { main: 'usd', other: 'eur', scale: 1, otherScale: 1 };
}

function makeCharge(rand: () => number, mix: ReturnType<typeof currenciesFor>, id: string, created: number): FakeCharge {
  const second = rand() < 0.12;
  const amount = Math.round(((second ? 900 : 1900) + rand() * 7000) * (second ? mix.otherScale : mix.scale));
  const failed = rand() < 0.04;
  const refunded = !failed && rand() < 0.05 ? amount : 0;
  // Earlier customers more often: regulars.
  const who = Math.floor(rand() ** 1.8 * CUSTOMERS);
  const first = FIRST[who % FIRST.length]!;
  const last = LAST[(who * 7) % LAST.length]!;
  return {
    id,
    object: 'charge',
    created,
    currency: second ? mix.other : mix.main,
    amount,
    amount_captured: failed ? 0 : amount,
    amount_refunded: refunded,
    captured: !failed,
    paid: !failed,
    status: failed ? 'failed' : 'succeeded',
    customer: `cus_demo_${who.toString().padStart(3, '0')}`,
    billing_details: { name: `${first} ${last}`, email: `${first.toLowerCase()}@example.com` },
    description: PLANS[Math.floor(rand() * PLANS.length)]!,
  };
}

/** Newest first: the year before `anchor` (busier lately), then one every `every` seconds up to `now`. */
function chargesFor(key: string, anchor: number, now: number, every: number): FakeCharge[] {
  const rand = seeded(key);
  const mix = currenciesFor(key);
  const out: FakeCharge[] = [];
  for (let i = 0; i < PAST; i++) {
    // Sales pick up over the months: the gaps get shorter towards now.
    const ago = SPAN_DAYS * (1 - i / PAST) ** 1.35 + rand() * 0.5;
    out.push(makeCharge(rand, mix, `ch_demo_${i.toString().padStart(4, '0')}`, Math.floor(anchor - ago * DAY)));
  }
  const live = seeded(`${key}:live`);
  for (let k = 1; anchor + k * every <= now; k++) {
    const c = makeCharge(live, mix, `ch_demo_live_${k.toString().padStart(4, '0')}`, anchor + k * every);
    // A payment that just arrived went through.
    out.push({ ...c, status: 'succeeded', paid: true, captured: true, amount_captured: c.amount, amount_refunded: 0 });
  }
  return out.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
}

const json = (status: number, body: unknown) => ({ status, headers: { get: () => null }, json: async () => body });

export function demoStripe(now: () => number = Date.now, every: number = DEMO_PAYMENT_EVERY): FetchLike {
  // Fixed when the demo starts: the past stays the same, and new payments arrive after it.
  const anchor = Math.floor(now() / 1000);
  return async (url, init) => {
    const key = (init.headers.Authorization ?? '').replace(/^Bearer /, '');
    if (key.includes('revoked')) return json(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    const u = new URL(url);
    if (u.pathname === '/v1/account') {
      if (key.includes('noaccount')) return json(403, { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions' } });
      return json(200, { id: 'acct_demo', settings: { dashboard: { display_name: key.includes('_live_') ? 'Bob API, Inc.' : 'Demo Shop (test)' } } });
    }
    if (key.includes('nocharges')) return json(403, { error: { type: 'invalid_request_error', message: 'The provided key does not have the required permissions' } });
    if (u.pathname === '/v1/refunds') return json(200, { object: 'list', data: [], has_more: false });
    if (u.pathname !== '/v1/charges') return json(404, { error: { type: 'invalid_request_error', message: 'Unrecognized request URL' } });
    const limit = Number(u.searchParams.get('limit') ?? 10);
    const after = u.searchParams.get('starting_after');
    const since = Number(u.searchParams.get('created[gte]') ?? 0);
    const all = chargesFor(key, anchor, Math.floor(now() / 1000), every).filter((c) => c.created >= since);
    const from = after ? all.findIndex((c) => c.id === after) + 1 : 0;
    const data = all.slice(from, from + limit);
    return json(200, { object: 'list', data, has_more: from + limit < all.length });
  };
}
