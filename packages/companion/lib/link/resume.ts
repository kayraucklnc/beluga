import { BACKGROUND_GRACE_MS } from './protocol';

/**
 * What to do with the link when the app comes back to the front, and when it drops while you look
 * (BLG-105). Pure, so tests/companion-resume.test.ts runs it without React Native; lib/store.ts
 * acts on the answers.
 *
 * Why it's needed: on Android the app's timers stop while it's in the background, so the 15 s grace
 * that should close the link often never fires there, and the OS freezes the process instead. The Mac
 * stops hearing keepalives and drops its end, but the phone still thinks the link is open: coming
 * back it only said "focus" into a dead socket and waited, often a minute, for the keepalive to
 * notice, and a link that closed then was never dialed again. So: judge by the wall clock, check an
 * open link with a quick ping, dial at once when it's gone, never dial twice at the same time.
 */

/** The store's phases (LinkState['phase']). */
export type ResumePhase = 'idle' | 'dialing' | 'open' | 'closed' | 'unreachable' | 'refused' | 'asleep';

export interface ResumeInput {
  readonly phase: ResumePhase;
  readonly now: number;
  /** When the app went to the background (undefined: it didn't, or it's the first start). */
  readonly awayAt?: number;
  /** When the dial now in flight began. */
  readonly dialingSince?: number;
  /** A ping to check the open link is already out. */
  readonly probing?: boolean;
}

export type ResumeAction =
  /** Nothing: a dial or a check is already under way (one at a time). */
  | { readonly do: 'none' }
  /** The link is open: tell the Mac, and check it answers (a ping, a short wait). */
  | { readonly do: 'probe' }
  /** Dial now. `replace`: there is a link or a dial, but it can't be trusted: drop it first. */
  | { readonly do: 'open'; readonly replace: boolean };

/** How long a ping on resume may take before the link counts as half-open and is replaced. */
export const PROBE_TIMEOUT_MS = 3_000;
/**
 * A dial older than this is stuck (the dial and the welcome are given 20 s each, src/companion/
 * client.ts; a frozen process can leave one hanging past both): a new one replaces it.
 */
export const DIAL_STALE_MS = 45_000;

export function onResume(s: ResumeInput): ResumeAction {
  switch (s.phase) {
    case 'idle':
      return { do: 'none' };
    case 'dialing':
      // A dial that was under way when the app was frozen for long: its sockets and timers are as stale.
      if (s.awayAt !== undefined && s.now - s.awayAt >= BACKGROUND_GRACE_MS) return { do: 'open', replace: true };
      // Single flight: switching apps quickly mustn't restart a dial that's getting there.
      if (s.dialingSince !== undefined && s.now - s.dialingSince < DIAL_STALE_MS) return { do: 'none' };
      return { do: 'open', replace: true };
    case 'open': {
      // Away past the grace: the link should have closed, and on Android it was likely frozen
      // instead. Don't trust it: a fresh dial is about a second.
      if (s.awayAt !== undefined && s.now - s.awayAt >= BACKGROUND_GRACE_MS) return { do: 'open', replace: true };
      return s.probing ? { do: 'none' } : { do: 'probe' };
    }
    default:
      // closed, asleep, unreachable, refused: dial now (a refused phone hears why again).
      return { do: 'open', replace: false };
  }
}

/** Automatic retries while the app is in front and the link dropped or the Mac didn't answer. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/** After this many, it keeps trying every RETRY_SLOW_MS while you look (BLG-126: the Mac may be fixing its relay); never in the background. */
export const RETRY_LIMIT = 6;
export const RETRY_SLOW_MS = 30_000;

/**
 * Should the link be dialed again by itself, and when? `attempt` counts retries since the link was
 * last open or the app last came to the front (both reset it to 0). Undefined: don't.
 */
export function retryDelay(s: { readonly phase: ResumePhase; readonly active: boolean; readonly attempt: number }, jitter = 0): number | undefined {
  if (!s.active) return undefined;
  if (s.phase !== 'closed' && s.phase !== 'asleep' && s.phase !== 'unreachable') return undefined;
  const base = s.attempt >= RETRY_LIMIT ? RETRY_SLOW_MS : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** s.attempt);
  // Up to a quarter more, so phones don't all knock at the same moment.
  return Math.round(base * (1 + Math.max(0, Math.min(1, jitter)) / 4));
}

/**
 * The grace timer fired: close only if the app really is still away, and long enough by the wall
 * clock (Android runs a paused timer late, often just as the app comes back).
 */
export function graceExpired(s: { readonly active: boolean; readonly awayAt?: number; readonly now: number }): boolean {
  return !s.active && s.awayAt !== undefined && s.now - s.awayAt >= BACKGROUND_GRACE_MS - 250;
}
