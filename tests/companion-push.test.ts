import { describe, expect, it } from 'vitest';
import { AWAY_AFTER_MS, type PushContext, atMac, deliver } from '../src/companion/push.js';

const base: PushContext = { linked: false, onScreen: new Set(), inFront: false, macFront: false, canPush: true };

describe('when to tell the phone', () => {
  it('tells the app when it is open, and says nothing about what is on screen', () => {
    expect(deliver({ kind: 'needsYou', topic: 'conv:ws:a' }, { ...base, linked: true, inFront: true, onScreen: new Set(['home']), macIdleMs: 1_000 })).toBe('nudge');
    expect(deliver({ kind: 'done', topic: 'conv:ws:a' }, { ...base, linked: true, inFront: true, onScreen: new Set(['conv:ws:a']) })).toBe('none');
    // On screen but the app is in the background, and you're away from the Mac: worth a nudge.
    expect(deliver({ kind: 'done', topic: 'conv:ws:a' }, { ...base, linked: true, inFront: false, onScreen: new Set(['conv:ws:a']), macIdleMs: AWAY_AFTER_MS + 1 })).toBe('nudge');
  });

  it('notifies only after five minutes away from the Mac (BLG-360)', () => {
    expect(AWAY_AFTER_MS).toBe(5 * 60_000);
    // Used the Mac in the last five minutes: held, linked in the background or not.
    expect(deliver({ kind: 'needsYou' }, { ...base, macIdleMs: 4 * 60_000 })).toBe('held');
    expect(deliver({ kind: 'needsYou' }, { ...base, linked: true, macIdleMs: 30_000 })).toBe('held');
    // Away: a push, or a nudge to a phone kept linked in the background.
    expect(deliver({ kind: 'needsYou' }, { ...base, macIdleMs: AWAY_AFTER_MS + 1 })).toBe('push');
    expect(deliver({ kind: 'needsYou' }, { ...base, linked: true, macIdleMs: AWAY_AFTER_MS + 1 })).toBe('nudge');
    // A Beluga window left in front doesn't count when the keyboard and mouse say you're away.
    expect(deliver({ kind: 'needsYou' }, { ...base, macFront: true, macIdleMs: AWAY_AFTER_MS + 1 })).toBe('push');
  });

  it('falls back to the front window when idle time is unknown, and needs a way to reach the phone', () => {
    expect(atMac({ macFront: true })).toBe(true);
    expect(deliver({ kind: 'needsYou' }, { ...base, macFront: true })).toBe('held');
    // Idle time unknown (not a Mac): no window in front counts as away.
    expect(deliver({ kind: 'mentions' }, base)).toBe('push');
    // No relay set up for this phone and not linked: nothing.
    expect(deliver({ kind: 'needsYou' }, { ...base, canPush: false, macIdleMs: AWAY_AFTER_MS + 1 })).toBe('none');
  });
});
