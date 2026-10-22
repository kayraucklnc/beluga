import type { ConnectionTrouble } from '@klaud/core/store.js';

/** Why, for the status's tooltip. */
export function connectionHint(trouble: ConnectionTrouble): string {
  return trouble.attempt > 1 ? `${trouble.reason} (${trouble.attempt} tries so far)` : trouble.reason;
}

/** The one line the room shows while it can't be reached, e.g. "Can’t reach the room · retrying in 12s". */
export function connectionLine(trouble: ConnectionTrouble, now: number): { lead: string; detail: string; canRetry: boolean } {
  if (trouble.state === 'offline') return { lead: 'Offline', detail: trouble.reason, canRetry: false };
  const left = Math.ceil(((trouble.retryAt ?? now) - now) / 1000);
  const detail = left > 0 ? `retrying in ${left}s` : 'retrying now…';
  return { lead: 'Can’t reach the room', detail, canRetry: left > 0 };
}
