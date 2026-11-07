/**
 * A schedule, as a trigger: what it says and how it reads. Browser-safe: types and pure functions.
 * Its clock is in clock.ts, its zod checks in schema.ts.
 */

export const SCHEDULE_EVERY = ['hours', 'day', 'other-day', 'week', 'month'] as const;
export type ScheduleEvery = (typeof SCHEDULE_EVERY)[number];
export const SCHEDULE_HOURS = [1, 2, 3, 6, 12] as const;
export type ScheduleHours = (typeof SCHEDULE_HOURS)[number];

export interface ScheduleTrigger {
  readonly kind: 'schedule';
  readonly every: ScheduleEvery;
  /** Local time, "HH:MM" (for `hours`: where the hours line up, "00:00" by default). */
  readonly at: string;
  readonly hours?: ScheduleHours;
  /** For `week`: 0 Sunday … 6 Saturday (Monday when empty). */
  readonly days?: readonly number[];
  /** For `month`: 1…28. */
  readonly day?: number;
  /** A slot that passed while the Mac slept or Beluga was closed: run once when it's back, or skip it. */
  readonly missed: 'catch-up' | 'skip';
}

/** When a schedule runs, in one sentence: the words every feature with a schedule shows. `showAt`: how its "HH:MM" reads. */
export function scheduleWords(trigger: ScheduleTrigger, showAt: (at: string) => string = clockText): string {
  const at = showAt(trigger.at);
  switch (trigger.every) {
    case 'hours': {
      const n = trigger.hours ?? 1;
      return n === 1 ? 'Every hour' : `Every ${n} hours`;
    }
    case 'day':
      return `Every day at ${at}`;
    case 'other-day':
      return `Every other day at ${at}`;
    case 'week': {
      const days = [...new Set(trigger.days?.length ? trigger.days : [1])].filter((d) => d >= 0 && d <= 6).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      if (days.length === 7) return `Every day at ${at}`;
      if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return `Every weekday at ${at}`;
      if (days.length === 2 && days.includes(0) && days.includes(6)) return `Every weekend day at ${at}`;
      return `Every week on ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${at}`;
    }
    case 'month':
      return `Every month on the ${ordinal(trigger.day ?? 1)} at ${at}`;
  }
  return at;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "07:00" → "7:00". */
export function clockText(at: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  return m ? `${Number(m[1])}:${m[2]}` : at;
}

/** 1 → "1st", 22 → "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}
