import { describe, expect, it } from 'vitest';
import { convertTotals, mainCurrency, minorUnits } from '../src/core/earnings-store.js';
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
});
