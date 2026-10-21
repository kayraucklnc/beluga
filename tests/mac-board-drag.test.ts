import { describe, expect, it } from 'vitest';
import { closeUp, landingIndex, neighbours, spotIn, withGap } from '../packages/mac/src/tasks/board-drag.js';

/** The board's drag, the pure part: measured once, then only arithmetic while the pointer moves. */

const slots = [
  { id: 'a', top: 0, height: 60 },
  { id: 'b', top: 66, height: 80 },
  { id: 'c', top: 152, height: 60 },
];

describe('the board drag', () => {
  it('closes up the room the lifted card leaves', () => {
    expect(closeUp(slots, 'b', 6)).toEqual([
      { top: 0, bottom: 60 },
      { top: 66, bottom: 126 },
    ]);
    expect(closeUp(slots, 'zz', 6)).toHaveLength(3);
  });

  it('finds the column and the place under the pointer from the measured board', () => {
    const cols = [
      { key: 'todo', box: { top: 100, bottom: 700, left: 0, right: 280 }, origin: 140, cards: closeUp(slots, 'b', 6) },
      { key: 'done', box: { top: 100, bottom: 700, left: 292, right: 572 }, origin: 120, cards: [] },
    ];
    expect(spotIn(100, 150, cols)).toEqual({ key: 'todo', index: 0 });
    expect(spotIn(100, 140 + 50, cols)).toEqual({ key: 'todo', index: 1 });
    expect(spotIn(100, 140 + 200, cols)).toEqual({ key: 'todo', index: 2 });
    // Past the last column still lands there; an empty column takes it first.
    expect(spotIn(900, 300, cols)).toEqual({ key: 'done', index: 0 });
    expect(spotIn(10, 10, [])).toBeUndefined();
    expect(landingIndex(5, [])).toBe(0);
  });

  it('shows the gap where it would land, and its neighbours', () => {
    const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(withGap(cards, 'a', 1)).toEqual([{ id: 'b' }, 'gap', { id: 'c' }]);
    expect(neighbours(cards, 'a', 1)).toEqual({ before: 'b', after: 'c' });
  });
});
