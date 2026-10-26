/**
 * Runs of chat messages, as a messaging app groups them (BLG-210): one person's messages (or their
 * Claude's) within a few minutes. The first of a run has the name above it; the last has the
 * picture, the bubble's tail and the time. A task's card stands on its own. Plain: no React Native.
 */

export interface RunMessage {
  readonly from: string;
  readonly mine: boolean;
  readonly ts: number;
  readonly claude?: boolean;
  readonly task?: unknown;
}

/** Messages this far apart start a new run (the Mac's chat uses the same). */
export const RUN_GAP_MS = 3 * 60_000;

const joins = (a: RunMessage | undefined, b: RunMessage | undefined): boolean =>
  Boolean(a && b && !a.task && !b.task && a.from === b.from && a.mine === b.mine && Boolean(a.claude) === Boolean(b.claude) && b.ts - a.ts < RUN_GAP_MS && new Date(a.ts).toDateString() === new Date(b.ts).toDateString());

/** Where message `i` sits in its run. */
export function runOf(messages: readonly RunMessage[], i: number): { first: boolean; last: boolean } {
  return { first: !joins(messages[i - 1], messages[i]), last: !joins(messages[i], messages[i + 1]) };
}
