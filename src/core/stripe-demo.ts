import type { FetchLike } from './stripe-client.js';

/**
 * A pretend Stripe for the demo (and the Mac app's end-to-end tests): it answers the three
 * calls klaud makes with made-up charges and refunds, so the earnings show without a real
 * key and nothing leaves the computer. Keys with "revoked" in them are refused, keys with
 * "nocharges" may not read charges, keys with "noaccount" may not read the account.
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
}

const DAY = 86_400;

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

function chargesFor(key: string, now: number): FakeCharge[] {
  const rand = seeded(key);
  const mix = currenciesFor(key);
  const out: FakeCharge[] = [];
  for (let i = 0; i < 260; i++) {
    const second = rand() < 0.12;
    const amount = Math.round(((second ? 900 : 1900) + rand() * 7000) * (second ? mix.otherScale : mix.scale));
    const failed = rand() < 0.04;
    const refunded = !failed && rand() < 0.05 ? amount : 0;
    out.push({
      id: `ch_demo_${i.toString().padStart(4, '0')}`,
      object: 'charge',
      created: Math.floor(now - (260 - i) * 1.3 * DAY),
      currency: second ? mix.other : mix.main,
      amount,
      amount_captured: failed ? 0 : amount,
      amount_refunded: refunded,
      captured: !failed,
      paid: !failed,
      status: failed ? 'failed' : 'succeeded',
    });
  }
  return out.reverse();
}

const json = (status: number, body: unknown) => ({ status, headers: { get: () => null }, json: async () => body });

export function demoStripe(now: () => number = Date.now): FetchLike {
  // Fixed when the demo starts, so a refresh finds the same charges (and nothing new).
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
    const all = chargesFor(key, anchor).filter((c) => c.created >= since);
    const from = after ? all.findIndex((c) => c.id === after) + 1 : 0;
    const data = all.slice(from, from + limit);
    return json(200, { object: 'list', data, has_more: from + limit < all.length });
  };
}
