import type { NotifySettings } from './settings-schema.js';

// Do Not Disturb, as data: the core checks it before a desktop notification, the screens show it.

export type DndChoice = 'hour' | 'tomorrow' | 'forever';

export const DND_CHOICES: ReadonlyArray<{ readonly value: DndChoice; readonly label: string }> = [
  { value: 'hour', label: 'For 1 hour' },
  { value: 'tomorrow', label: 'Until tomorrow' },
  { value: 'forever', label: 'Until I turn it off' },
];

/** The hour "tomorrow" starts (8 in the morning, local time). */
const MORNING = 8;

/** Do Not Disturb as it is saved, for a choice made at `now`. */
export function dndFor(choice: DndChoice, now = Date.now()): NonNullable<NotifySettings['dnd']> {
  if (choice === 'forever') return {};
  if (choice === 'hour') return { until: now + 3_600_000 };
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(MORNING, 0, 0, 0);
  return { until: d.getTime() };
}

/** Do Not Disturb is on right now. */
export const dndActive = (n: Pick<NotifySettings, 'dnd'>, now = Date.now()): boolean => Boolean(n.dnd) && (n.dnd?.until === undefined || n.dnd.until > now);

/** "until 14:30", "until tomorrow 08:00", "until you turn it off"; '' when off. */
export function dndLabel(n: Pick<NotifySettings, 'dnd'>, now = Date.now()): string {
  if (!dndActive(n, now)) return '';
  const until = n.dnd?.until;
  if (until === undefined) return 'until you turn it off';
  const end = new Date(until);
  const time = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
  return end.toDateString() === new Date(now).toDateString() ? `until ${time}` : `until tomorrow ${time}`;
}

/** Each press makes it last longer: off → 1 hour → until tomorrow → until you turn it off → off. */
export function nextDnd(n: Pick<NotifySettings, 'dnd'>, now = Date.now()): NotifySettings['dnd'] {
  if (!dndActive(n, now)) return dndFor('hour', now);
  const until = n.dnd?.until;
  if (until === undefined) return null;
  return until <= dndFor('hour', now).until! ? dndFor('tomorrow', now) : dndFor('forever', now);
}
