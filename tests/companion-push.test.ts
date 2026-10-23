import { describe, expect, it } from 'vitest';
import { AWAY_AFTER_MS, type PushContext, deliver } from '../src/companion/push.js';

const base: PushContext = { linked: false, onScreen: new Set(), inFront: false, macFront: false, canPush: true };

describe('when to tell the phone', () => {
  it('nudges in-band while linked, and says nothing about what is on screen', () => {
    expect(deliver({ kind: 'needsYou', topic: 'conv:ws:a' }, { ...base, linked: true, inFront: true, onScreen: new Set(['home']) })).toBe('nudge');
    expect(deliver({ kind: 'done', topic: 'conv:ws:a' }, { ...base, linked: true, inFront: true, onScreen: new Set(['conv:ws:a']) })).toBe('none');
    // On screen but the app is in the background: still worth a nudge.
    expect(deliver({ kind: 'done', topic: 'conv:ws:a' }, { ...base, linked: true, inFront: false, onScreen: new Set(['conv:ws:a']) })).toBe('nudge');
  });

  it('pushes only when you are away from the Mac', () => {
    expect(deliver({ kind: 'needsYou' }, { ...base, macIdleMs: AWAY_AFTER_MS + 1 })).toBe('push');
    expect(deliver({ kind: 'needsYou' }, { ...base, macIdleMs: 5_000 })).toBe('none');
    expect(deliver({ kind: 'needsYou' }, { ...base, macFront: true, macIdleMs: AWAY_AFTER_MS + 1 })).toBe('none');
    // Idle time unknown (not a Mac): no window in front counts as away.
    expect(deliver({ kind: 'mentions' }, base)).toBe('push');
    // No relay set up for this phone: nothing.
    expect(deliver({ kind: 'needsYou' }, { ...base, canPush: false, macIdleMs: AWAY_AFTER_MS + 1 })).toBe('none');
  });
});
