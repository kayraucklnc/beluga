import { describe, expect, it } from 'vitest';
import { FRAMES, H, W, burst, piece, pixels, step } from '../packages/mac/src/components/pixel-burst-model.js';

/** Every pixel a set of pieces shows over the whole burst. */
function flight(pieces: ReturnType<typeof burst>): Array<{ x: number; y: number }> {
  const seen: Array<{ x: number; y: number }> = [];
  for (let frame = 0; frame <= FRAMES; frame++) {
    for (const p of pieces) seen.push(...pixels(p, frame));
    step(pieces);
  }
  return seen;
}

const outside = (seen: ReadonlyArray<{ x: number; y: number }>) => seen.filter((p) => p.x < 0 || p.y < 0 || p.x >= W || p.y >= H);

describe('the pixel burst of a new payment', () => {
  it('never reaches the edge of its canvas: no coin cut off at the top, no square at a side', () => {
    // Every piece's random draws at their extremes (each one low or high), for a narrow amount and a wide one.
    for (const coin of [false, true]) {
      for (const width of [10, 54, 400]) {
        for (let mask = 0; mask < 64; mask++) {
          let call = 0;
          const extreme = (): number => (mask >> call++ % 6) & 1 ? 0.999999 : 0;
          expect(outside(flight([piece(coin, width, extreme)])), `coin ${coin}, width ${width}, mask ${mask}`).toEqual([]);
        }
      }
    }
    // And whole bursts, as they come.
    for (let i = 0; i < 200; i++) expect(outside(flight(burst(60)))).toEqual([]);
  });

  it('has its coins hop above the amount, and everything gone by the last frame', () => {
    const pieces = burst(60);
    const coins = pieces.filter((p) => p.coin);
    expect(coins).toHaveLength(3);
    const start = coins.map((c) => c.y);
    for (let frame = 0; frame < 10; frame++) step(pieces);
    coins.forEach((c, i) => expect(c.y).toBeLessThan(start[i]! - 15));
    for (let frame = 10; frame < FRAMES; frame++) step(pieces);
    expect(pieces.flatMap((p) => pixels(p, FRAMES))).toEqual([]);
  });
});
