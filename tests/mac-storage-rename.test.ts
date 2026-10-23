import { describe, expect, it } from 'vitest';
import { renameStorage } from '../packages/mac/src/lib/storage-rename.js';

/** A localStorage stand-in (the window's storage, as WebKit keeps it). */
function memory(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Klaud's window storage becomes Beluga's on the first launch (packages/mac/src/lib/storage-rename.ts). */
describe('renameStorage', () => {
  it('moves every klaud.* key to its beluga.* name', () => {
    const s = memory({
      'klaud.prefs.v1': '{"theme":"dark"}',
      'klaud.onboarding.v1': '{"how":"finished"}',
      'klaud.tasks.v1': '{}',
      'klaud.plan.v1': '{}',
      'klaud.wsShells.v1': '{}',
      'klaud.earnings.hint.v1': 'dismissed',
      'klaud.relaunch.v1': '{"view":{"kind":"home"}}',
      'klaud.mergeMethod': 'squash',
      'klaud.overview.v1': '{}',
      'klaud.usage.sort': 'cost',
      other: 'x',
    });
    expect(renameStorage(s)).toBe(10);
    expect(Object.fromEntries(s.map)).toEqual({
      other: 'x',
      'beluga.prefs.v1': '{"theme":"dark"}',
      'beluga.onboarding.v1': '{"how":"finished"}',
      'beluga.tasks.v1': '{}',
      'beluga.plan.v1': '{}',
      'beluga.wsShells.v1': '{}',
      'beluga.earnings.hint.v1': 'dismissed',
      'beluga.relaunch.v1': '{"view":{"kind":"home"}}',
      'beluga.mergeMethod': 'squash',
      'beluga.overview.v1': '{}',
      'beluga.usage.sort': 'cost',
    });
  });

  it("never overwrites what Beluga saved itself, and runs only once", () => {
    const s = memory({ 'klaud.prefs.v1': 'old', 'beluga.prefs.v1': 'new' });
    expect(renameStorage(s)).toBe(0);
    expect(Object.fromEntries(s.map)).toEqual({ 'beluga.prefs.v1': 'new' });
    expect(renameStorage(s)).toBe(0);
  });

  it('keeps an old key it could not move (full storage), to try again next launch', () => {
    const s = memory({ 'klaud.prefs.v1': 'old' });
    s.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(renameStorage(s)).toBe(0);
    expect(s.map.get('klaud.prefs.v1')).toBe('old');
  });
});
