import { describe, expect, it } from 'vitest';
import { dueNow, lastSlotAt, nextRunAt } from '../src/core/sentinel/clock.js';
import type { ScheduleTrigger } from '../src/core/sentinel/model.js';

/** When schedules run (docs/sentinel.md §4, "Clock"), in a named zone so the tests read the same anywhere. */

const NY = 'America/New_York';
const BERLIN = 'Europe/Berlin';
const t = (iso: string): number => new Date(iso).getTime();
const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());
const every = (patch: Partial<ScheduleTrigger>): ScheduleTrigger => ({ kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up', ...patch });

describe('nextRunAt', () => {
  it('every day: today if it’s still ahead, else tomorrow', () => {
    const daily = every({});
    expect(iso(nextRunAt(daily, undefined, t('2026-10-26T06:59:00-04:00'), NY))).toBe('2026-10-26T11:00:00.000Z');
    expect(iso(nextRunAt(daily, undefined, t('2026-10-26T07:00:00-04:00'), NY))).toBe('2026-10-27T11:00:00.000Z');
  });

  it('after the last slot it ran, even when that was days ago (the caller sees it is due)', () => {
    const daily = every({});
    expect(iso(nextRunAt(daily, t('2026-10-23T07:00:00-04:00'), t('2026-10-26T10:00:00-04:00'), NY))).toBe('2026-10-24T11:00:00.000Z');
  });

  it('every week on Mon and Wed', () => {
    const week = every({ every: 'week', days: [1, 3], at: '09:30' });
    // Mon 26 Oct 2026, after 9:30 → Wed 28.
    expect(iso(nextRunAt(week, undefined, t('2026-10-26T10:00:00-04:00'), NY))).toBe('2026-10-28T13:30:00.000Z');
    // Wed 28, after → Mon 2 Nov (EST by then).
    expect(iso(nextRunAt(week, undefined, t('2026-10-28T10:00:00-04:00'), NY))).toBe('2026-11-02T14:30:00.000Z');
  });

  it('a week with no days picked runs on Mondays', () => {
    expect(iso(nextRunAt(every({ every: 'week', days: [] }), undefined, t('2026-10-27T00:00:00-04:00'), NY))).toBe('2026-11-02T12:00:00.000Z');
  });

  it('every month on a day from 1 to 28', () => {
    const monthly = every({ every: 'month', day: 1, at: '09:00' });
    expect(iso(nextRunAt(monthly, undefined, t('2026-10-26T12:00:00-04:00'), NY))).toBe('2026-11-01T14:00:00.000Z');
    const late = every({ every: 'month', day: 28, at: '09:00' });
    expect(iso(nextRunAt(late, undefined, t('2027-01-29T12:00:00-05:00'), NY))).toBe('2027-02-28T14:00:00.000Z');
  });

  it('every few hours, lined up on the time', () => {
    const three = every({ every: 'hours', hours: 3, at: '00:15' });
    expect(iso(nextRunAt(three, undefined, t('2026-10-26T04:10:00-04:00'), NY))).toBe('2026-10-26T10:15:00.000Z');
    expect(iso(nextRunAt(three, undefined, t('2026-10-26T22:00:00-04:00'), NY))).toBe('2026-10-27T04:15:00.000Z');
    const hourly = every({ every: 'hours', at: '00:00' });
    expect(iso(nextRunAt(hourly, undefined, t('2026-10-26T04:10:00-04:00'), NY))).toBe('2026-10-26T09:00:00.000Z');
  });

  it('every other day: two days apart, whenever it last ran', () => {
    const other = every({ every: 'other-day', at: '08:00' });
    const a = nextRunAt(other, undefined, t('2026-10-25T09:00:00-04:00'), NY)!;
    const b = nextRunAt(other, a, a, NY)!;
    expect(b - a).toBe(2 * 24 * 3600_000);
    // 26 Oct 2026 is an even day since 1970: its slot is one.
    expect(iso(a)).toBe('2026-10-26T12:00:00.000Z');
  });

  it('by hand: never on its own', () => {
    expect(nextRunAt({ kind: 'manual' }, undefined, Date.now())).toBeUndefined();
  });
});

describe('daylight saving', () => {
  it('a time the clocks skip runs just after the gap, once', () => {
    const daily = every({ at: '02:30' });
    // New York springs forward at 2:00 on 8 March 2026: 2:30 doesn't happen, it runs at 3:30 EDT.
    const first = nextRunAt(daily, undefined, t('2026-03-08T00:00:00-05:00'), NY)!;
    expect(iso(first)).toBe('2026-03-08T07:30:00.000Z');
    expect(iso(nextRunAt(daily, first, first, NY))).toBe('2026-03-09T06:30:00.000Z');
  });

  it('a time that happens twice runs the first time only', () => {
    const daily = every({ at: '01:30' });
    // New York falls back at 2:00 on 1 November 2026: 1:30 EDT, then 1:30 EST.
    const first = nextRunAt(daily, undefined, t('2026-11-01T00:00:00-04:00'), NY)!;
    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(nextRunAt(daily, first, first, NY))).toBe('2026-11-02T06:30:00.000Z');
    // Berlin falls back on 25 October 2026: 2:30 CEST is the one.
    const berlin = nextRunAt(every({ at: '02:30' }), undefined, t('2026-10-25T00:00:00+02:00'), BERLIN)!;
    expect(iso(berlin)).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(nextRunAt(every({ at: '02:30' }), berlin, berlin, BERLIN))).toBe('2026-10-26T01:30:00.000Z');
  });

  it('7:00 stays 7:00 local across the change', () => {
    const daily = every({});
    const before = nextRunAt(daily, undefined, t('2026-03-28T00:00:00+01:00'), BERLIN)!;
    expect(iso(before)).toBe('2026-03-28T06:00:00.000Z');
    expect(iso(nextRunAt(daily, before, before, BERLIN))).toBe('2026-03-29T05:00:00.000Z');
  });
});

describe('missed slots', () => {
  const daily = every({});
  const lastRan = t('2026-10-23T07:00:00-04:00');
  const now = t('2026-10-26T10:00:00-04:00');

  it('the latest slot at or before now', () => {
    expect(iso(lastSlotAt(daily, now, NY))).toBe('2026-10-26T11:00:00.000Z');
  });

  it('catch-up: runs once for every slot missed, never once per slot', () => {
    const due = dueNow(daily, lastRan, now, { tz: NY });
    expect(due).toEqual({ kind: 'run', slot: t('2026-10-26T07:00:00-04:00'), late: true, missed: 3 });
    // Recorded as run: nothing more is due until tomorrow.
    if (due.kind !== 'run') throw new Error('expected a run');
    expect(dueNow(daily, due.slot, now, { tz: NY })).toEqual({ kind: 'wait', at: t('2026-10-27T07:00:00-04:00') });
  });

  it('skip: a missed slot doesn’t run, and the next comes after it', () => {
    const skipping = every({ missed: 'skip' });
    expect(dueNow(skipping, lastRan, now, { tz: NY })).toEqual({ kind: 'skip', slot: t('2026-10-26T07:00:00-04:00'), missed: 3 });
  });

  it('a slot that only just passed runs, even when skipping missed ones (the Mac woke up just after)', () => {
    const skipping = every({ missed: 'skip' });
    const just = t('2026-10-26T07:00:20-04:00');
    expect(dueNow(skipping, lastRan, just, { tz: NY })).toMatchObject({ kind: 'run', late: false });
  });

  it('on time: runs, not late', () => {
    const at = t('2026-10-26T07:00:20-04:00');
    expect(dueNow(daily, t('2026-10-25T07:00:00-04:00'), at, { tz: NY })).toEqual({ kind: 'run', slot: t('2026-10-26T07:00:00-04:00'), late: false, missed: 1 });
  });

  it('turned on just now: waits for the next slot', () => {
    const on = t('2026-10-26T07:05:00-04:00');
    expect(dueNow(daily, on, on + 1000, { tz: NY })).toEqual({ kind: 'wait', at: t('2026-10-27T07:00:00-04:00') });
  });
});
