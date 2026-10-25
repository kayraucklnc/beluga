import { describe, expect, it } from 'vitest';
import { DIAL_STALE_MS, graceExpired, onResume, RETRY_LIMIT, RETRY_MAX_MS, RETRY_SLOW_MS, retryDelay } from '../packages/companion/lib/link/resume.js';
import { BACKGROUND_GRACE_MS } from '../src/companion/protocol.js';

/**
 * The phone coming back to the front (BLG-105, packages/companion/lib/link/resume.ts): Kayra came
 * back from another app and the phone sat "linked" on a dead link until the app was restarted.
 */

const now = 1_000_000;

describe('coming back to the front', () => {
  it('checks an open link with a ping after a quick switch, once at a time', () => {
    expect(onResume({ phase: 'open', now, awayAt: now - 3_000 })).toEqual({ do: 'probe' });
    // Opened by a deep link or a notification without a background first: still checked.
    expect(onResume({ phase: 'open', now })).toEqual({ do: 'probe' });
    // Switching back and forth quickly: the ping already out answers for both.
    expect(onResume({ phase: 'open', now, awayAt: now - 1_000, probing: true })).toEqual({ do: 'none' });
  });

  it('replaces a link left "open" past the grace (Android froze it instead of closing it)', () => {
    expect(onResume({ phase: 'open', now, awayAt: now - BACKGROUND_GRACE_MS })).toEqual({ do: 'open', replace: true });
    expect(onResume({ phase: 'open', now, awayAt: now - 10 * 60_000, probing: true })).toEqual({ do: 'open', replace: true });
  });

  it('dials at once when the link is down, whatever the reason', () => {
    for (const phase of ['closed', 'asleep', 'unreachable', 'refused'] as const) {
      expect(onResume({ phase, now, awayAt: now - 60_000 })).toEqual({ do: 'open', replace: false });
    }
    // Not paired: nothing to dial.
    expect(onResume({ phase: 'idle', now })).toEqual({ do: 'none' });
  });

  it('never dials twice at once, but replaces a dial that got stuck', () => {
    expect(onResume({ phase: 'dialing', now, dialingSince: now - 2_000, awayAt: now - 1_000 })).toEqual({ do: 'none' });
    expect(onResume({ phase: 'dialing', now, dialingSince: now - DIAL_STALE_MS })).toEqual({ do: 'open', replace: true });
    // A dial frozen with the app for long is as stale as the link would be.
    expect(onResume({ phase: 'dialing', now, dialingSince: now - 20_000, awayAt: now - 20_000 })).toEqual({ do: 'open', replace: true });
    // Rapid switching: each resume finds the first dial and leaves it alone.
    for (let i = 0; i < 20; i++) {
      const t = now + i * 300;
      expect(onResume({ phase: 'dialing', now: t, dialingSince: now, awayAt: t - 200 })).toEqual({ do: 'none' });
    }
  });
});

describe('trying again by itself while you look', () => {
  it('backs off from a second to half a minute, then keeps trying every half minute while you look', () => {
    const delays = Array.from({ length: RETRY_LIMIT + 2 }, (_, attempt) => retryDelay({ phase: 'asleep', active: true, attempt }));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, RETRY_MAX_MS, RETRY_SLOW_MS, RETRY_SLOW_MS]);
    expect(retryDelay({ phase: 'closed', active: true, attempt: 0 })).toBe(1_000);
    // A little jitter, never more than a quarter.
    expect(retryDelay({ phase: 'closed', active: true, attempt: 2 }, 1)).toBe(5_000);
  });

  it('never in the background, never while open or dialing, never for a refusal', () => {
    expect(retryDelay({ phase: 'closed', active: false, attempt: 0 })).toBeUndefined();
    for (const phase of ['open', 'dialing', 'refused', 'idle'] as const) expect(retryDelay({ phase, active: true, attempt: 0 })).toBeUndefined();
  });
});

describe('the grace in the background', () => {
  it('closes only when the app is still away and long enough by the clock', () => {
    expect(graceExpired({ active: false, awayAt: now - BACKGROUND_GRACE_MS, now })).toBe(true);
    // Android ran the paused timer late, just as the app came back: keep the link.
    expect(graceExpired({ active: true, awayAt: now - 5 * 60_000, now })).toBe(false);
    expect(graceExpired({ active: false, awayAt: now - 2_000, now })).toBe(false);
    expect(graceExpired({ active: false, now })).toBe(false);
  });
});
