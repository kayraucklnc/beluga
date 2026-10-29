import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A localStorage stand-in (the window's storage). */
function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** The project home's lists as last read, shown at once on the next visit (packages/mac/src/lib/last-seen.ts). */
describe('last seen', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps an answer for the next launch, written once for a burst', async () => {
    const store = memory();
    vi.stubGlobal('localStorage', store);
    const { keepSeen, lastSeen } = await import('../packages/mac/src/lib/last-seen.js');
    keepSeen('ci.runs:p1', { kind: 'github', runs: [1] });
    keepSeen('ci.runs:p1', { kind: 'github', runs: [2, 1] });
    expect(lastSeen('ci.runs:p1')).toEqual({ kind: 'github', runs: [2, 1] });
    expect(store.map.size).toBe(0);
    vi.advanceTimersByTime(600);
    vi.resetModules();
    const again = await import('../packages/mac/src/lib/last-seen.js');
    expect(again.lastSeen('ci.runs:p1')).toEqual({ kind: 'github', runs: [2, 1] });
    expect(again.lastSeen('ci.runs:p2')).toBeUndefined();
  });

  it('keeps the most recently used few dozen', async () => {
    vi.stubGlobal('localStorage', memory());
    const { keepSeen, lastSeen } = await import('../packages/mac/src/lib/last-seen.js');
    for (let i = 0; i < 45; i++) keepSeen(`k${i}`, i);
    expect(lastSeen('k0')).toBeUndefined();
    expect(lastSeen('k44')).toBe(44);
    expect(lastSeen('k5')).toBe(5);
  });

  it('shrugs off storage that is broken or missing', async () => {
    vi.stubGlobal('localStorage', memory({ 'beluga.lastSeen.v1': '{not json' }));
    const { keepSeen, lastSeen } = await import('../packages/mac/src/lib/last-seen.js');
    expect(lastSeen('a')).toBeUndefined();
    keepSeen('a', 1);
    expect(lastSeen('a')).toBe(1);
  });
});
