import { describe, expect, it } from 'vitest';
import { snoozePresets } from '../src/shared/snooze-presets.js';

/** Local dates, so the rules read the same in any time zone. */
const at = (...parts: [number, number, number, number, number]): number => new Date(...parts).getTime();
const when = (now: number) => Object.fromEntries(snoozePresets(now).map((p) => [p.label, p.at]));

describe('snoozePresets', () => {
  it('offers the four presets, in order', () => {
    expect(snoozePresets(at(2026, 10, 4, 14, 30)).map((p) => p.label)).toEqual(['In 1 hour', 'In 3 hours', 'Tomorrow 9:00', 'Next week']);
  });

  it('counts hours from now and tomorrow from midnight', () => {
    const now = at(2026, 10, 4, 14, 30);
    expect(when(now)).toMatchObject({ 'In 1 hour': at(2026, 10, 4, 15, 30), 'In 3 hours': at(2026, 10, 4, 17, 30), 'Tomorrow 9:00': at(2026, 10, 5, 9, 0) });
  });

  it('crosses a day, a month and a year end', () => {
    const now = at(2026, 11, 31, 23, 30);
    expect(when(now)).toMatchObject({ 'In 1 hour': at(2027, 0, 1, 0, 30), 'Tomorrow 9:00': at(2027, 0, 1, 9, 0) });
  });

  it('next week is the coming Monday at 9:00: the day after a Sunday, seven days after a Monday', () => {
    expect(when(at(2026, 10, 8, 20, 0))['Next week']).toBe(at(2026, 10, 9, 9, 0));
    expect(when(at(2026, 10, 9, 8, 0))['Next week']).toBe(at(2026, 10, 16, 9, 0));
    expect(when(at(2026, 10, 7, 12, 0))['Next week']).toBe(at(2026, 10, 9, 9, 0));
  });
});
