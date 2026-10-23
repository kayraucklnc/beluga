import type { AppState, ConnectionTrouble } from '../../../../../src/core/store.js';

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

/** The sidebar footer's words and tone: who's in the room, or how the link to it is doing. */
export function footerStatus(st: Pick<AppState, 'status' | 'room'> & { readonly people: number; readonly ready: boolean; readonly reconnecting: boolean }): { label: string; tone: 'ok' | 'warn' | 'error' } {
  if (st.status === 'connected') return { label: st.people > 1 ? `${st.people} people in ${st.room}` : st.ready ? 'Invite ready' : 'Just you', tone: 'ok' };
  if (st.reconnecting) return { label: 'Reconnecting…', tone: 'warn' };
  return st.status === 'connecting' ? { label: 'Connecting…', tone: 'warn' } : { label: 'Offline', tone: 'error' };
}
