/**
 * What the composer's one round button does (components/Composer.tsx), kept free of React so it
 * can be tested. While Claude works, a tap queues (as the Mac's ↩: after what Claude is doing) and
 * Steer (the Mac's ⌥↩: now, at its next step) is a long-press away. Photos go with a message, not
 * with a steer: the Mac's steer takes words only, so with photos the message queues.
 */
export type ComposerAction = 'send' | 'queue' | 'steer' | 'stop' | 'idle';

export interface ComposerState {
  /** Claude is working in this conversation. */
  readonly working: boolean;
  /** Words in the field (trimmed). */
  readonly hasText: boolean;
  /** Photos attached. */
  readonly photos: number;
  /** This conversation can be steered (the screen gave an onSteer). */
  readonly canSteer: boolean;
  /** This conversation can be stopped (the screen gave an onStop). */
  readonly canStop: boolean;
}

export interface ComposerPlan {
  /** What a tap does. */
  readonly tap: ComposerAction;
  /** What a long-press offers besides the tap (empty: the long-press does nothing). */
  readonly more: readonly ('queue' | 'steer')[];
}

export function composerPlan(s: ComposerState): ComposerPlan {
  const content = s.hasText || s.photos > 0;
  if (!content) return { tap: s.working && s.canStop ? 'stop' : 'idle', more: [] };
  if (!s.working) return { tap: 'send', more: [] };
  // Working: a tap queues. Steer is one long-press away, for words only.
  const steer = s.canSteer && s.hasText && s.photos === 0;
  return { tap: s.canSteer ? 'queue' : 'send', more: steer ? ['queue', 'steer'] : [] };
}

/** The field grows with what you write up to this many lines, then scrolls inside. */
export const FIELD_LINES = 7;
export const FIELD_LINE_HEIGHT = 22;
/** The field's own vertical padding (top and bottom each). */
export const FIELD_PAD = 9;

/** The field's height for its content's: one line at least, FIELD_LINES at most. */
export function fieldHeight(content: number): number {
  const min = FIELD_LINE_HEIGHT + FIELD_PAD * 2;
  const max = FIELD_LINE_HEIGHT * FIELD_LINES + FIELD_PAD * 2;
  return Math.round(Math.min(max, Math.max(min, content)));
}

/** At most this many photos in one message (the Mac's MAX_UPLOADS). */
export const MAX_PHOTOS = 10;
