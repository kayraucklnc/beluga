import { describe, expect, it } from 'vitest';
import type { SubAgent } from '../src/core/store.js';
import type { StepSummary } from '../src/shared/steps.js';
import { foldOf, timelineOf } from '../packages/mac/src/chat/steps/timeline.js';

/** A card's steps with sub-agents and background work where they started, and which rows fold (KLD-51). */

const step = (id: string, startedAt: number, status: StepSummary['status'] = 'done'): StepSummary => ({ id, kind: 'tool', title: id, status, startedAt });
const sub = (id: string, startedAt: number | undefined, status: SubAgent['status'] = 'done'): SubAgent => ({ id, title: id, steps: [], status, kind: 'background', ...(startedAt === undefined ? {} : { startedAt }) });
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('timelineOf', () => {
  const rows = [step('a', 10), step('b', 20), step('c', 30)];

  it('puts a sub-agent where its launching call was', () => {
    expect(ids(timelineOf(rows, [sub('task', 99)], (id) => (id === 'task' ? 15 : undefined)))).toEqual(['a', 'sub:task', 'b', 'c']);
  });

  it('else where it started, in start order', () => {
    expect(ids(timelineOf(rows, [sub('late', 25), sub('early', 12)], () => undefined))).toEqual(['a', 'sub:early', 'b', 'sub:late', 'c']);
  });

  it('after the steps when it has no start (kept before it had one, or a friend’s one-line steps)', () => {
    expect(ids(timelineOf(rows, [sub('old', undefined)], () => undefined))).toEqual(['a', 'b', 'c', 'sub:old']);
    expect(ids(timelineOf([], [sub('only', 5)], () => undefined))).toEqual(['sub:only']);
  });
});

describe('foldOf', () => {
  it('folds all but the last few finished rows, never just one', () => {
    const t = timelineOf([step('a', 1), step('b', 2), step('c', 3)], [], () => undefined);
    expect(foldOf(t, 2).older).toEqual([]);
    const more = timelineOf([step('a', 1), step('b', 2), step('c', 3), step('d', 4)], [], () => undefined);
    const { older, shown } = foldOf(more, 2);
    expect(ids(older)).toEqual(['a', 'b']);
    expect(ids(shown)).toEqual(['c', 'd']);
  });

  it('keeps a running sub-agent shown in its place, and folds a finished one with the steps', () => {
    const t = timelineOf([step('a', 1), step('b', 3), step('c', 5), step('d', 7), step('e', 9)], [sub('bg', 2, 'running'), sub('done', 4)], () => undefined);
    const { older, shown } = foldOf(t, 2);
    expect(ids(older)).toEqual(['a', 'b', 'sub:done', 'c']);
    expect(ids(shown)).toEqual(['sub:bg', 'd', 'e']);
  });
});
