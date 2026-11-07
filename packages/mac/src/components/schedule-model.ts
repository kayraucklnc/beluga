import type { ScheduleEvery, ScheduleHours, ScheduleTrigger } from '../../../../src/shared/schedule/trigger.js';

/** ScheduleControls, its plain parts: the choices and the edits. Pure (tests/mac-sentinel.test.ts). */

export const EVERY_CHOICES: ReadonlyArray<{ readonly value: ScheduleEvery; readonly label: string }> = [
  { value: 'day', label: 'Every day' },
  { value: 'other-day', label: 'Every other day' },
  { value: 'week', label: 'Every week' },
  { value: 'month', label: 'Every month' },
  { value: 'hours', label: 'Every few hours' },
];

export const DEFAULT_SCHEDULE: ScheduleTrigger = { kind: 'schedule', every: 'day', at: '07:00', missed: 'catch-up' };

/** Another "every": the fields that kind needs, the rest kept where they make sense. */
export function withEvery(t: ScheduleTrigger, every: ScheduleEvery): ScheduleTrigger {
  const base = { kind: 'schedule' as const, every, at: t.at, missed: t.missed };
  if (every === 'week') return { ...base, days: t.days?.length ? t.days : [1] };
  if (every === 'month') return { ...base, day: t.day ?? 1 };
  if (every === 'hours') return { ...base, hours: t.hours ?? 3 };
  return base;
}

/** A weekday chip pressed: on or off (one stays on). Monday first, as the chips show them. */
export function toggleDay(days: readonly number[] | undefined, day: number): number[] {
  const now = new Set(days?.length ? days : [1]);
  if (now.has(day)) {
    if (now.size > 1) now.delete(day);
  } else now.add(day);
  return [...now].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

/** The chips' order: Monday … Sunday. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

export const HOURS_CHOICES: readonly ScheduleHours[] = [1, 2, 3, 6, 12];
