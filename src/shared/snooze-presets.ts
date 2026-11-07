/** When a snooze can end, for the Mac's menu and the phone's sheet. Pure, in the computer's local time. */

export interface SnoozePreset {
  readonly label: string;
  /** When it ends (ms). */
  readonly at: number;
}

const HOUR = 3_600_000;
const WAKE_HOUR = 9;
const MONDAY = 1;

export function snoozePresets(now: number): readonly SnoozePreset[] {
  return [
    { label: 'In 1 hour', at: now + HOUR },
    { label: 'In 3 hours', at: now + 3 * HOUR },
    { label: `Tomorrow ${WAKE_HOUR}:00`, at: morningIn(now, 1) },
    { label: 'Next week', at: morningIn(now, daysToNextMonday(now)) },
  ];
}

/** Monday itself counts a whole week; Sunday is one day away. */
const daysToNextMonday = (now: number): number => (7 + MONDAY - new Date(now).getDay()) % 7 || 7;

const morningIn = (now: number, days: number): number => {
  const day = new Date(now);
  day.setDate(day.getDate() + days);
  day.setHours(WAKE_HOUR, 0, 0, 0);
  return day.getTime();
};
