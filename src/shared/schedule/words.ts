/** How a schedule's next run and state read, the same on the Mac and on the phone. Pure. */

const MINUTE = 60_000;

/** How long until the next run: "next in 3 h". */
export function nextIn(next: number, now: number): string {
  const minutes = Math.ceil((next - now) / MINUTE);
  if (minutes <= 0) return 'due now';
  if (minutes === 1) return 'next in 1 min';
  if (minutes < 60) return `next in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `next in ${hours} h`;
  return `next in ${Math.round(hours / 24)} days`;
}

/** A row's line from the words the daemon sent: "Every day at 21:00 · next in 3 h". */
export function sentLine(s: { readonly sentence: string; readonly status: string; readonly enabled: boolean; readonly next?: number | undefined }, now: number): string {
  const state = s.status === 'running' ? 'running now' : s.status === 'paused' ? 'paused' : s.status === 'waiting' ? 'waiting for the chat' : s.next !== undefined ? nextIn(s.next, now) : s.enabled ? '' : 'done';
  return state ? `${s.sentence} · ${state}` : s.sentence;
}
