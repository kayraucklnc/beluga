import { describe, expect, it } from 'vitest';
import { composerPlan, FIELD_LINE_HEIGHT, FIELD_LINES, FIELD_PAD, fieldHeight } from '../packages/companion/lib/composer.js';

/** The phone composer's one round button (packages/companion/lib/composer.ts, BLG-107). */
const base = { working: false, hasText: false, photos: 0, canSteer: true, canStop: true };

describe('composerPlan', () => {
  it('is idle with nothing written, Stop while Claude works', () => {
    expect(composerPlan(base)).toEqual({ tap: 'idle', more: [] });
    expect(composerPlan({ ...base, working: true })).toEqual({ tap: 'stop', more: [] });
    expect(composerPlan({ ...base, working: true, canStop: false })).toEqual({ tap: 'idle', more: [] });
  });

  it('sends when Claude is idle, words or a photo alone', () => {
    expect(composerPlan({ ...base, hasText: true })).toEqual({ tap: 'send', more: [] });
    expect(composerPlan({ ...base, photos: 1 })).toEqual({ tap: 'send', more: [] });
  });

  it('queues by default while Claude works, with Steer a long-press away', () => {
    expect(composerPlan({ ...base, working: true, hasText: true })).toEqual({ tap: 'queue', more: ['queue', 'steer'] });
  });

  it('queues photos: a steer takes words only', () => {
    expect(composerPlan({ ...base, working: true, hasText: true, photos: 2 })).toEqual({ tap: 'queue', more: [] });
    expect(composerPlan({ ...base, working: true, photos: 1 })).toEqual({ tap: 'queue', more: [] });
  });

  it('just sends where there is no steering (a friend’s task)', () => {
    expect(composerPlan({ ...base, working: true, hasText: true, canSteer: false })).toEqual({ tap: 'send', more: [] });
  });
});

describe('fieldHeight', () => {
  it('is one line at least and FIELD_LINES at most', () => {
    expect(fieldHeight(0)).toBe(FIELD_LINE_HEIGHT + 2 * FIELD_PAD);
    expect(fieldHeight(100)).toBe(100);
    expect(fieldHeight(10_000)).toBe(FIELD_LINE_HEIGHT * FIELD_LINES + 2 * FIELD_PAD);
    expect(fieldHeight(Number.POSITIVE_INFINITY)).toBe(FIELD_LINE_HEIGHT * FIELD_LINES + 2 * FIELD_PAD);
  });
});
