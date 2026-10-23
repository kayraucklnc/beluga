import { describe, expect, it } from 'vitest';
import { type NotificationAccess, UNKNOWN_ACCESS, notifyStatus, testOutcome } from '../packages/mac/src/lib/sounds/access-model.js';
import { isTestNotice } from '../packages/mac/src/lib/brand.js';
import { TEST_WINDOW_MS, testTone } from '../packages/mac/src/lib/sounds/test-sound.js';

/**
 * Settings › Notifications in the Mac app: the status line at the top (what macOS and Beluga's
 * own switches let through, and the button that fixes it), what a test notification reports,
 * and the test's sound, which the window plays itself so you hear it whatever macOS does.
 */

const allowed: NotificationAccess = { state: 'allowed', alerts: true, sound: true, focus: 'off' };
const own = { desktop: true, quietUntil: null };

describe('the status line', () => {
  it('says notifications are on when nothing is in the way', () => {
    const s = notifyStatus(allowed, own);
    expect(s).toMatchObject({ tone: 'ok', title: 'Notifications are on' });
    expect(s.action).toBeUndefined();
    expect(s.detail).not.toContain('Focus');
  });

  it('hints at Focus when macOS won’t say whether one is on', () => {
    const s = notifyStatus({ ...allowed, focus: 'unknown' }, own);
    expect(s.title).toBe('Notifications are on');
    expect(s.detail).toContain('Do Not Disturb or another Focus can still hold them');
    // An older app shell doesn't say either.
    const { focus: _, ...older } = allowed;
    expect(notifyStatus(older, own).detail).toContain('Focus');
  });

  it('says macOS blocks them, what to turn on, and opens Beluga’s notification settings', () => {
    const s = notifyStatus({ ...allowed, state: 'off', alerts: false }, own);
    expect(s).toMatchObject({ tone: 'warn', title: 'Blocked by macOS', action: 'notifications' });
    expect(s.fix).toContain('Allow notifications');
    expect(s.fix).toContain('Banners');
    expect(s.fix).toContain('Play sound');
  });

  it('names banners or sound being off, banners first', () => {
    expect(notifyStatus({ ...allowed, alerts: false, sound: false }, own)).toMatchObject({ title: 'Banners are off in macOS', action: 'notifications' });
    expect(notifyStatus({ ...allowed, sound: false }, own)).toMatchObject({ title: 'Sounds are off in macOS', action: 'notifications' });
  });

  it('names the Focus that is on and opens Focus settings', () => {
    const s = notifyStatus({ ...allowed, focus: 'on', focusName: 'Do Not Disturb' }, own);
    expect(s).toMatchObject({ tone: 'warn', title: 'Do Not Disturb is on', action: 'focus' });
    expect(s.fix).toContain('Allowed Apps');
    expect(notifyStatus({ ...allowed, focus: 'on' }, own).title).toBe('A Focus is on');
  });

  it('macOS blocking them comes before a Focus', () => {
    expect(notifyStatus({ ...allowed, state: 'off', focus: 'on' }, own).title).toBe('Blocked by macOS');
  });

  it('never claims macOS hasn’t asked: Beluga’s banners don’t need asking, so a test is what tells', () => {
    const s = notifyStatus({ ...allowed, state: 'notAsked', alerts: false }, own);
    expect(s).toMatchObject({ tone: 'muted', title: 'Send a test to check', action: 'notifications' });
    expect(s.title).not.toContain('Not set up');
  });

  it('then Beluga’s own switches', () => {
    expect(notifyStatus(allowed, { desktop: false, quietUntil: null })).toMatchObject({ tone: 'muted', title: 'Desktop notifications are off' });
    const quiet = notifyStatus(allowed, { desktop: true, quietUntil: 'until 15:00' });
    expect(quiet.title).toBe('Beluga’s Do Not Disturb is on');
    expect(quiet.detail).toContain('until 15:00');
    // macOS comes first: turning Beluga's switch on wouldn't help.
    expect(notifyStatus({ ...allowed, state: 'off' }, { desktop: false, quietUntil: null }).title).toBe('Blocked by macOS');
  });

  it('when macOS won’t say, asks for a test and offers Notification Settings; and while checking', () => {
    expect(notifyStatus(UNKNOWN_ACCESS, own)).toMatchObject({ tone: 'muted', title: 'Send a test to check', action: 'notifications' });
    expect(notifyStatus(undefined, own)).toMatchObject({ tone: 'muted', title: 'Checking…' });
  });
});

describe('what a test notification reports', () => {
  it('sent and shown: where to look, and the sound you heard', () => {
    const o = testOutcome(allowed, '8-bit · Coin');
    expect(o.tone).toBe('ok');
    expect(o.text).toContain('top right');
    expect(o.text).toContain('You heard “8-bit · Coin” here.');
    expect(o.action).toBeUndefined();
  });

  it('never claims it showed when macOS held it', () => {
    expect(testOutcome({ ...allowed, state: 'off' }, null)).toMatchObject({ tone: 'warn', text: 'Sent, but macOS blocked it.', action: 'notifications' });
    expect(testOutcome({ ...allowed, alerts: false }, null).text).toContain('banners are off');
    expect(testOutcome({ ...allowed, sound: false }, null).text).toContain('silent');
    expect(testOutcome({ ...allowed, focus: 'on', focusName: 'Work' }, null)).toMatchObject({ tone: 'warn', text: 'Sent, but Work is holding it in Notification Center, muted.', action: 'focus' });
    // Not a warning when macOS just won't say: where to look, and what to open if nothing shows.
    const unknown = testOutcome({ ...allowed, state: 'notAsked' }, null);
    expect(unknown).toMatchObject({ tone: 'ok', action: 'notifications' });
    expect(unknown.text).toContain('clicking in Beluga closes it');
  });

  it('when Focus can’t be checked, says what to look for and offers Focus settings', () => {
    const o = testOutcome({ ...allowed, focus: 'unknown' }, null);
    expect(o.text).toContain('the moon in the menu bar');
    expect(o.action).toBe('focus');
  });
});

describe('the test’s sound', () => {
  const coin = { kind: 'chip', id: 'coin' } as const;

  it('is played by the window on the click, and not again when the notification arrives', () => {
    expect(testTone({ sound: true, tone: coin }, true, 1_000, Number.NEGATIVE_INFINITY)).toEqual(coin);
    expect(testTone({ sound: true, tone: coin }, false, 3_000, 1_000)).toBeNull();
  });

  it('a test asked for elsewhere (the terminal app) is played when it arrives', () => {
    expect(testTone({ sound: true, tone: coin }, false, 100_000, Number.NEGATIVE_INFINITY)).toEqual(coin);
    expect(testTone({ sound: true, tone: coin }, false, 1_000 + TEST_WINDOW_MS, 1_000)).toEqual(coin);
    // An older daemon that only says "with sound": the default.
    expect(testTone({ sound: true }, false, 100_000, 0)).toEqual({ kind: 'mac', id: 'Glass' });
  });

  it('None stays silent', () => {
    expect(testTone({ sound: false, tone: { kind: 'none' } }, true, 0, 0)).toBeNull();
    expect(testTone({ sound: false }, true, 0, 0)).toBeNull();
  });

  it('is told apart from other notifications by its title', () => {
    expect(isTestNotice({ title: 'Notifications work' })).toBe(true);
    expect(isTestNotice({ title: 'Claude finished', tag: 'test' })).toBe(true);
    expect(isTestNotice({ title: 'Claude finished' })).toBe(false);
  });
});
