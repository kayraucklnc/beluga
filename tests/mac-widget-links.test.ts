import { describe, expect, it } from 'vitest';
import { boardLinkOf } from '../packages/mac/src/lib/widget-links.js';

/** A desktop widget's link (BLG-309) opens Sentinel on its board and tile; other links aren't one. */
describe('widget links', () => {
  it('a board and its tile, or Sentinel itself', () => {
    expect(boardLinkOf('beluga://board/d1?tile=t%201')).toEqual({ board: 'd1', tile: 't 1' });
    expect(boardLinkOf('beluga://board/d1')).toEqual({ board: 'd1' });
    expect(boardLinkOf('beluga://sentinel')).toEqual({});
    expect(boardLinkOf('beluga://join/abc')).toBeUndefined();
    expect(boardLinkOf('klaud://board/d1')).toBeUndefined();
  });
});
