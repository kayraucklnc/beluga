import { describe, expect, it } from 'vitest';
import { convertParts, convertTotals, currencyChoices, earningsCurrency, mainCurrency, minorUnits } from '../src/core/earnings-store.js';
import { convertSummary, formatGlance, formatMoney, missingNote, ratesWhen } from '../packages/mac/src/lib/money.js';
import { PrefsPatch } from '../src/ipc/api.js';
import { prefsFrom } from '../src/core/store.js';
import { Settings } from '../src/shared/settings-schema.js';
import { FxService, parseRates } from '../src/core/fx-rates.js';
import { Store, initialState } from '../src/core/store.js';

const fx = { rates: { eur: 0.9, jpy: 150, gbp: 0.8 }, at: 1 };

describe('adding up earnings in several currencies', () => {
  it('converts through dollars, in each currency’s smallest unit', () => {
    expect(minorUnits('usd')).toBe(100);
    expect(minorUnits('jpy')).toBe(1);
    // $100 + €90 (= $100) + ¥15000 (= $100) = $300.
    expect(convertTotals([{ currency: 'usd', amount: 10_000 }, { currency: 'eur', amount: 9_000 }, { currency: 'jpy', amount: 15_000 }], 'usd', fx)).toBe(30_000);
    // The same in euros.
    expect(convertTotals([{ currency: 'usd', amount: 10_000 }, { currency: 'eur', amount: 9_000 }], 'eur', fx)).toBe(18_000);
    // One currency needs no rates.
    expect(convertTotals([{ currency: 'chf', amount: 500 }], 'chf', undefined)).toBe(500);
    // A currency without a rate: no total.
    expect(convertTotals([{ currency: 'usd', amount: 1 }, { currency: 'xyz', amount: 1 }], 'usd', fx)).toBeUndefined();
  });

  it('shows totals in the currency most was earned in', () => {
    const earnings = {
      a: { connected: true as const, mode: 'live' as const, totals: [{ currency: 'eur', amount: 90_000 }] },
      b: { connected: true as const, mode: 'live' as const, totals: [{ currency: 'usd', amount: 50_000 }] },
    };
    expect(mainCurrency(earnings, fx)).toBe('eur');
    expect(mainCurrency({}, fx)).toBe('usd');
  });

  it('reads the rates service’s answer, and keeps only sane rates', () => {
    expect(parseRates({ base: 'USD', rates: { EUR: 0.92, JPY: 151, BAD: -1, xx: 2 } }, 5)).toEqual({ rates: { eur: 0.92, jpy: 151 }, at: 5 });
    expect(parseRates({ nope: true }, 5)).toBeUndefined();
  });

  it('fetches rates only while some project earns, and not again while they are fresh', async () => {
    const store = new Store(initialState('test', 'ask'));
    let calls = 0;
    const fetchRates = (async () => {
      calls++;
      return new Response(JSON.stringify({ base: 'USD', rates: { EUR: 0.9 } }));
    }) as typeof fetch;
    const service = new FxService({ store, file: null, fetch: fetchRates, now: () => 1000 });
    await service.refreshIfStale();
    expect(calls).toBe(0);
    store.dispatch({ type: 'earnings', root: '/p', earnings: { connected: true, mode: 'live', totals: [{ currency: 'eur', amount: 1 }] } });
    await service.refreshIfStale();
    expect(calls).toBe(1);
    expect(store.getState().fx).toEqual({ rates: { eur: 0.9 }, at: 1000 });
    await service.refreshIfStale();
    expect(calls).toBe(1);
  });

  it('fetches stale rates when a Stripe count starts, or when you choose another currency, and keeps fresh ones', async () => {
    const store = new Store(initialState('test', 'ask'));
    let calls = 0;
    let now = 1000;
    const fetchRates = (async () => {
      calls++;
      return new Response(JSON.stringify({ base: 'USD', rates: { EUR: 0.9 } }));
    }) as typeof fetch;
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const service = new FxService({ store, file: null, fetch: fetchRates, now: () => now });
    service.start();
    store.dispatch({ type: 'earnings', root: '/p', earnings: { connected: true, mode: 'live', totals: [{ currency: 'eur', amount: 1 }] } });
    await settle();
    expect(calls).toBe(1);
    // A day later the daily Stripe count starts: the rates come along.
    now += 21 * 3600_000;
    store.dispatch({ type: 'earnings', root: '/p', earnings: { connected: true, mode: 'live', refreshing: true, totals: [{ currency: 'eur', amount: 1 }] } });
    await settle();
    expect(calls).toBe(2);
    // Fresh rates: choosing another currency converts with them, nothing is fetched.
    store.dispatch({ type: 'prefs', prefs: { earningsCurrency: 'try' } });
    await settle();
    expect(calls).toBe(2);
    // Stale again: choosing one fetches.
    now += 21 * 3600_000;
    store.dispatch({ type: 'prefs', prefs: { earningsCurrency: 'eur' } });
    await settle();
    expect(calls).toBe(3);
    service.stop();
  });
});

describe('showing earnings in one currency', () => {
  const rates = { rates: { eur: 0.9, try: 34, inr: 84, jpy: 150 }, at: Date.UTC(2026, 9, 19, 9) };

  it('leaves out what has no rate (never NaN) and says so', () => {
    const totals = [{ currency: 'usd', amount: 581_229 }, { currency: 'inr', amount: 26_900 }, { currency: 'xyz', amount: 500 }];
    const parts = convertParts(totals, 'usd', { rates: { eur: 0.9 }, at: 1 });
    expect(parts.amount).toBe(581_229);
    expect(parts.missing).toEqual([{ currency: 'inr', amount: 26_900 }, { currency: 'xyz', amount: 500 }]);
    expect(parts.converted).toBe(false);
    expect(Number.isNaN(parts.amount)).toBe(false);
    // No rate for the target: only what's already in it counts.
    expect(convertParts([{ currency: 'try', amount: 100 }, { currency: 'usd', amount: 100 }], 'try', undefined)).toEqual({ amount: 100, missing: [{ currency: 'usd', amount: 100 }], converted: false });
    // Everything converts: TRY 14,255 + $5,812.29 + ₹269 in lira.
    const all = convertParts([{ currency: 'try', amount: 1_425_500 }, { currency: 'usd', amount: 581_229 }, { currency: 'inr', amount: 26_900 }], 'try', rates);
    expect(all.missing).toEqual([]);
    expect(all.converted).toBe(true);
    expect(all.amount).toBe(1_425_500 + Math.round((5812.29 + 269 / 84) * 34 * 100));
    expect(missingNote([{ currency: 'inr', amount: 26_900 }])).toBe('₹269.00 not included (no rate yet)');
    expect(missingNote([])).toBeUndefined();
  });

  it('uses the currency you chose, else the one most was earned in', () => {
    const earnings = { a: { connected: true as const, mode: 'live' as const, totals: [{ currency: 'usd', amount: 50_000 }] } };
    expect(earningsCurrency(undefined, earnings, rates)).toBe('usd');
    expect(earningsCurrency('try', earnings, rates)).toBe('try');
    expect(earningsCurrency('BAD!', earnings, rates)).toBe('usd');
  });

  it('offers the currencies the rates cover, common ones first, and keeps your choice', () => {
    expect(currencyChoices({ rates: { zar: 18, eur: 0.9, try: 34, aed: 3.67, inr: 84 }, at: 1 })).toEqual(['usd', 'eur', 'try', 'inr', 'aed', 'zar']);
    expect(currencyChoices(undefined)).toEqual(['usd']);
    expect(currencyChoices(undefined, 'gbp')).toEqual(['usd', 'gbp']);
  });

  it('adds every project up, the biggest first, each with its part of the total', () => {
    const items = [
      { name: 'flyingpenguin', totals: [{ currency: 'try', amount: 1_425_500 }] },
      { name: 'vaas', totals: [{ currency: 'usd', amount: 581_229 }, { currency: 'inr', amount: 26_900 }] },
      { name: 'counting', totals: undefined },
    ];
    const summary = convertSummary(items, (i) => i.totals, 'usd', rates);
    expect(summary.rows.map((r) => r.item.name)).toEqual(['vaas', 'flyingpenguin', 'counting']);
    const lira = Math.round((14_255 / 34) * 100);
    const vaas = 581_229 + Math.round((269 / 84) * 100);
    expect(summary.total.amount).toBe(lira + vaas);
    expect(summary.total.converted).toBe(true);
    expect(summary.rows[0]!.share + summary.rows[1]!.share).toBeCloseTo(1);
    expect(summary.rows[2]!.share).toBe(0);
    // Without a rupee rate: the rupees are left out, once, for the whole.
    const partial = convertSummary(items, (i) => i.totals, 'usd', { rates: { try: 34 }, at: 1 });
    expect(partial.total.amount).toBe(lira + 581_229);
    expect(partial.total.missing).toEqual([{ currency: 'inr', amount: 26_900 }]);
  });

  it('formats a glance: exact when small, compact when large, symbols rather than codes', () => {
    expect(formatGlance(8_450, 'usd')).toBe('$84.50');
    expect(formatGlance(581_229, 'usd')).toBe('$5,812');
    expect(formatGlance(21_460_000, 'try')).toBe('₺214.6K');
    expect(formatMoney(1_425_500, 'try')).toBe('₺14,255.00');
    expect(formatMoney(150_000, 'cad', true)).toBe('CA$1.5K');
  });

  it('says how fresh the rates are', () => {
    const now = new Date(2026, 9, 19, 15).getTime();
    expect(ratesWhen(new Date(2026, 9, 19, 8).getTime(), now)).toBe('today');
    expect(ratesWhen(new Date(2026, 9, 18, 8).getTime(), now)).toBe('yesterday');
    expect(ratesWhen(new Date(2026, 9, 12, 8).getTime(), now)).toMatch(/^on \D*12|^on 12/);
  });

  it('keeps the choice in settings, and clears it with null', () => {
    expect(PrefsPatch.parse({ earningsCurrency: 'try' })).toEqual({ earningsCurrency: 'try' });
    expect(PrefsPatch.parse({ earningsCurrency: null })).toEqual({ earningsCurrency: null });
    expect(PrefsPatch.safeParse({ earningsCurrency: 'TRY!' }).success).toBe(false);
    expect(prefsFrom(Settings.parse({ earningsCurrency: 'eur' })).earningsCurrency).toBe('eur');
    expect(prefsFrom(Settings.parse({})).earningsCurrency).toBeUndefined();
    const store = new Store(initialState('test', 'ask'));
    store.dispatch({ type: 'prefs', prefs: { earningsCurrency: 'try' } });
    expect(store.getState().prefs.earningsCurrency).toBe('try');
    store.dispatch({ type: 'prefs', prefs: { earningsCurrency: null } });
    expect('earningsCurrency' in store.getState().prefs).toBe(false);
  });
});
