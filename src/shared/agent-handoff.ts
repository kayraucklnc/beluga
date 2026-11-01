import { type RunFailure, decodeFailure } from './run-failure.js';

/**
 * Moving a live conversation to another runtime (BLG-447, BLG-592), the parts both the daemon and
 * the screens need. Browser-safe.
 */

/**
 * How a conversation moves to an agent that can't read its session. 'quiet': nothing runs now; the
 * new agent gets the recent conversation with your next message. 'note': the old agent writes a
 * handoff note first (on its own plan), and the new one starts from it.
 */
export const HANDOFF_MODES = ['quiet', 'note'] as const;
export type HandoffMode = (typeof HANDOFF_MODES)[number];

/** The runtime a stored session id belongs to when none was recorded: everything before BLG-445 was Claude's. */
export const SESSION_RUNTIME_DEFAULT = 'claude';

/**
 * Can a run on `runtime` resume a session `made` (the runtime that made it) left? Its own, always.
 * A local model runs Claude Code too, on your same ~/.claude, so it also picks up Claude's
 * conversations (no handoff). Not the other way: a local model's turns can hold thinking without
 * Anthropic's signatures, which Claude's API may refuse, so Claude starts fresh (with a handoff) after one.
 */
export function resumable(made: string | undefined, runtime: string): boolean {
  const by = made ?? SESSION_RUNTIME_DEFAULT;
  return by === runtime || (runtime === 'local' && by === SESSION_RUNTIME_DEFAULT);
}

/** Does moving a place to `runtime` need a handoff (a live session another runtime holds, or one it can't resume)? */
export function needsHandoff(ws: { readonly sessionId?: string; readonly forkFromSession?: string; readonly sessionRuntime?: string }, runtime: string, canResume: (runtime: string) => boolean = () => true): boolean {
  if (!ws.sessionId && !ws.forkFromSession) return false;
  return !resumable(ws.sessionRuntime, runtime) || !canResume(runtime);
}

interface RunItem {
  readonly type: string;
  readonly channel: string;
  readonly status?: string;
  readonly text?: string;
}

/**
 * The plan limit the last run in `channel` stopped on, while it still holds (no reset time known,
 * or one still ahead). Then the agent there can't write a handoff note, so none is asked of it.
 */
export function limitHit(log: readonly RunItem[], channel: string, now = Date.now()): RunFailure | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i]!;
    if (l.type !== 'agent' || l.channel !== channel) continue;
    if (l.status !== 'error') return undefined;
    const failure = decodeFailure(l.text);
    return failure?.kind === 'usage_limit' && (!failure.resetsAt || failure.resetsAt > now) ? failure : undefined;
  }
  return undefined;
}
