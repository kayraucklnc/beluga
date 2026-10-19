import { DEFAULT_SOUND, NO_SOUND, type SoundChoice } from '../../../../../src/shared/notify-sound.js';

/**
 * The test notification's sound is played by the window, not macOS: you hear it even while
 * macOS holds the banner (a Focus, banners off), and only once, because the banner goes silent.
 * Settings plays it on the click; a test asked for elsewhere (the terminal app) is played when
 * its notification arrives.
 */

/** A test notification arriving within this long of the click was that click's. */
export const TEST_WINDOW_MS = 10_000;

/** What a desktop notification says about its sound (core/notify.ts DesktopNote). */
export interface TestNoteSound {
  readonly sound: boolean;
  readonly tone?: SoundChoice;
}

/** The sound to play for a test now (`null`: none chosen, or the click `playedAt` already played it). */
export function testTone(n: TestNoteSound, clicked: boolean, now: number, playedAt: number): SoundChoice | null {
  if (!clicked && now - playedAt < TEST_WINDOW_MS) return null;
  const tone = n.tone ?? (n.sound ? DEFAULT_SOUND : NO_SOUND);
  return tone.kind === 'none' ? null : tone;
}
