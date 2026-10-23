import { describe, expect, it } from 'vitest';
import { NO_SWIPE, SWIPE_THRESHOLD, type Swipe, swipeStep } from '../packages/mac/src/tasks/use-swipe-back.js';

/** A two-finger swipe right goes back out of a task, as in Chrome (BLG-5). */

const run = (moves: ReadonlyArray<readonly [number, number]>, from: Swipe = NO_SWIPE): Swipe => moves.reduce((s, [x, y]) => swipeStep(s, x, y), from);
const right = (total: number, steps = 10): Array<[number, number]> => Array.from({ length: steps }, () => [-total / steps, 0]);

describe('the swipe back', () => {
  it('fingers to the right (deltaX < 0) fill it up; past the threshold it goes back', () => {
    expect(run(right(SWIPE_THRESHOLD / 2)).progress).toBeCloseTo(0.5);
    expect(run(right(SWIPE_THRESHOLD * 2))).toEqual({ axis: 'x', progress: 1 });
  });

  it('swiping back to the left undoes it, never below nothing', () => {
    const s = run([...right(SWIPE_THRESHOLD), [SWIPE_THRESHOLD * 2, 0]]);
    expect(s.progress).toBe(0);
  });

  it('a gesture that starts as a scroll never becomes a swipe', () => {
    const s = run([[0, 30], ...right(SWIPE_THRESHOLD * 2)]);
    expect(s).toMatchObject({ axis: 'y', progress: 0 });
  });

  it('a diagonal mostly-down move is a scroll; tiny jitter decides nothing yet', () => {
    expect(swipeStep(NO_SWIPE, -10, 9).axis).toBe('y');
    expect(swipeStep(NO_SWIPE, -0.5, 0.5).axis).toBeUndefined();
    expect(run([[-0.5, 0.5], ...right(SWIPE_THRESHOLD)]).axis).toBe('x');
  });

  it('fingers to the left (forward) do nothing', () => {
    expect(run([[40, 0], [40, 0]])).toEqual({ axis: 'x', progress: 0 });
  });
});
