import { describe, expect, it } from 'vitest';
import { keepSameById, keepSameLists, sameItems } from '../packages/mac/src/lib/stable.js';
import { type Clock, throttle } from '../packages/mac/src/lib/throttle.js';

/** A clock the test moves by hand. */
function fakeClock(): Clock & { advance: (ms: number) => void } {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => void (timers = timers.filter((t) => t.id !== id)),
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

describe('stable picks (KLD-48)', () => {
  it('sameItems: the same objects in the same order', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    expect(sameItems([a, b], [a, b])).toBe(true);
    expect(sameItems([a, b], [b, a])).toBe(false);
    expect(sameItems([a], [{ id: 'a' }])).toBe(false);
    expect(sameItems([a], [a, b])).toBe(false);
    expect(sameItems(undefined, undefined)).toBe(true);
  });

  it('keepSameById keeps a step that reads the same, and takes one that changed', () => {
    const prev = [
      { id: 's1', status: 'done', label: 'Read a.ts' },
      { id: 's2', status: 'running', label: 'Ran npm test' },
    ];
    const next = keepSameById(prev, [
      { id: 's1', status: 'done', label: 'Read a.ts' },
      { id: 's2', status: 'done', label: 'Ran npm test' },
      { id: 's3', status: 'running', label: 'Read b.ts' },
    ]);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next[1]!.status).toBe('done');
    expect(next).toHaveLength(3);
  });

  it('keepSameLists keeps a list that holds the same items, and takes a changed one', () => {
    const t1 = { id: 't1' };
    const t2 = { id: 't2' };
    const prev = new Map([
      ['card-a', [t1]],
      ['card-b', [t2]],
    ]);
    const next = keepSameLists(
      prev,
      new Map([
        ['card-a', [t1]],
        ['card-b', [t2, t1]],
      ]),
    );
    expect(next.get('card-a')).toBe(prev.get('card-a'));
    expect(next.get('card-b')).toEqual([t2, t1]);
    expect(next.get('card-b')).not.toBe(prev.get('card-b'));
  });
});

describe('throttle (the Dock badge, KLD-48)', () => {
  it('runs the first ask at once, and asks within the gap as one run at its end', () => {
    const clock = fakeClock();
    let runs = 0;
    const t = throttle(() => runs++, () => 1000, clock);
    t.request();
    expect(runs).toBe(1);
    for (let i = 0; i < 50; i++) {
      clock.advance(10);
      t.request();
    }
    expect(runs).toBe(1);
    clock.advance(1000);
    expect(runs).toBe(2);
    // Nothing asked since: nothing runs.
    clock.advance(5000);
    expect(runs).toBe(2);
  });

  it('a stream of asks runs at most once a second in front, and once every 5 s behind', () => {
    const clock = fakeClock();
    let away = false;
    const at: number[] = [];
    const t = throttle(() => at.push(clock.now()), () => (away ? 5000 : 1000), clock);
    // Twenty events a second for 10 s.
    for (let i = 0; i < 200; i++) {
      t.request();
      clock.advance(50);
    }
    const gaps = at.slice(1).map((x, i) => x - at[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000);
    expect(at.length).toBeLessThanOrEqual(11);
    away = true;
    clock.advance(1000);
    const from = at.length;
    for (let i = 0; i < 400; i++) {
      t.request();
      clock.advance(50);
    }
    const behind = at.slice(from);
    expect(behind.slice(1).every((x, i) => x - behind[i]! >= 5000)).toBe(true);
    expect(behind.length).toBeLessThanOrEqual(5);
  });

  it('stop drops a run that was waiting', () => {
    const clock = fakeClock();
    let runs = 0;
    const t = throttle(() => runs++, () => 1000, clock);
    t.request();
    t.request();
    t.stop();
    clock.advance(2000);
    expect(runs).toBe(1);
  });
});
