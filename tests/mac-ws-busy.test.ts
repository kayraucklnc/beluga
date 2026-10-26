import { describe, expect, it } from 'vitest';
import { isBusy, subscribeBusy, whileBusy } from '../packages/mac/src/lib/ws-busy-model.js';

/** "Working…" on a worktree's Create PR, merge and the like belongs to that worktree (packages/mac/src/lib/ws-busy-model.ts). */

const later = (): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('a worktree’s step under way', () => {
  it('is that worktree’s only: switching to another shows it free, coming back shows it still working', async () => {
    const pr = later();
    const done = whileBusy('a', () => pr.promise);
    expect(isBusy('a')).toBe(true);
    expect(isBusy('b')).toBe(false);
    pr.resolve();
    await done;
    expect(isBusy('a')).toBe(false);
  });

  it('ends when the step fails too', async () => {
    const pr = later();
    const done = whileBusy('a', () => pr.promise);
    pr.reject(new Error('GitHub said no'));
    await done;
    expect(isBusy('a')).toBe(false);
  });

  it('runs once when pressed again while it runs', async () => {
    const pr = later();
    let calls = 0;
    const work = (): Promise<void> => {
      calls++;
      return pr.promise;
    };
    const first = whileBusy('a', work);
    await whileBusy('a', work);
    expect(calls).toBe(1);
    expect(isBusy('a')).toBe(true);
    pr.resolve();
    await first;
  });

  it('tells whoever shows it when it starts and ends', async () => {
    let told = 0;
    const off = subscribeBusy(() => told++);
    const pr = later();
    const done = whileBusy('a', () => pr.promise);
    expect(told).toBe(1);
    pr.resolve();
    await done;
    expect(told).toBe(2);
    off();
  });
});
