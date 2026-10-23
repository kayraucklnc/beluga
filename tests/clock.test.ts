import { describe, expect, it } from 'vitest';
import { hhmm, span } from '../src/shared/clock.js';

describe('clock words (one helper for plans, steer and usage limits)', () => {
  it('span: whole units so far', () => {
    expect(span(-5)).toBe('0s');
    expect(span(45_000)).toBe('45s');
    expect(span(90_000)).toBe('1m');
    expect(span(12 * 60_000)).toBe('12m');
    expect(span(120 * 60_000)).toBe('2h');
    expect(span(125 * 60_000)).toBe('2h 5m');
  });
  it('hhmm: local time, zero-padded', () => {
    expect(hhmm(new Date(2026, 9, 23, 9, 5).getTime())).toBe('09:05');
    expect(hhmm(new Date(2026, 9, 23, 15, 0).getTime())).toBe('15:00');
  });
});
