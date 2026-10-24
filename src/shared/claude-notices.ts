import type { LogItem } from '../core/store.js';

/**
 * Words about a Claude card that aren't Claude's answer: Claude Code's own notice that a plan
 * limit was hit, Beluga's note on a queued message Claude read mid-turn, and what an answered
 * turn still waits on. Browser-safe (the core writes them, the Mac app shows them).
 */

/** What a steered message's card says while it waits in the running turn for Claude's next step. */
export const READS_AFTER_STEP = 'Claude reads this after its current step';

/** What a steered message's card says while Claude's turn is being stopped so it reads it next (a long step, Send now). */
export const STOPPING_FOR = 'Claude stops its current step to read this';

/** What a queued message's card says when Claude took it in while it worked (see AgentHost.steer). */
export const STEERED_IN = 'Claude read this while it worked; the answer above covers it.';

/**
 * A steered message Claude hasn't read yet (BLG-54): its card is only a note, waiting in the
 * running turn for Claude's next step, or for the step being stopped. Once Claude reads it the
 * note says so (STEERED_IN) or the card becomes its own turn.
 */
export function steerWaiting(card: { readonly status: string; readonly text: string }): 'next_step' | 'stopping' | undefined {
  if (['done', 'error', 'denied', 'queued', 'interrupted'].includes(card.status)) return undefined;
  return card.text === READS_AFTER_STEP ? 'next_step' : card.text === STOPPING_FOR ? 'stopping' : undefined;
}

/** A message you steered in, as a screen shows it: on the message itself (BLG-54). */
export interface SteeredMessage {
  /** The request it is (Send now: host.steerNow). */
  readonly request: string;
  /** Still waiting to be read: at Claude's next step, or while its step is being stopped for it. */
  readonly waiting: 'next_step' | 'stopping';
}

/**
 * Your steered messages as the chat shows them: those Claude hasn't read yet (by message id),
 * and the note cards that say so (drawn on the message instead, so not drawn themselves).
 * Only messages that know their request (`request`, said in a workspace) are linked; others keep
 * their note card.
 */
export function steeredMessages(items: readonly LogItem[]): { readonly waiting: ReadonlyMap<string, SteeredMessage>; readonly notes: ReadonlySet<string> } {
  const waiting = new Map<string, SteeredMessage>();
  const notes = new Set<string>();
  const asked = new Map<string, string>();
  for (const l of items) if (l.type === 'chat' && l.request) asked.set(l.request, l.id);
  if (!asked.size) return { waiting, notes };
  const cards = new Set<string>();
  for (const l of items) {
    if (l.type !== 'agent') continue;
    const message = asked.get(l.requestId);
    if (!message) continue;
    cards.add(l.requestId);
    const how = steerWaiting(l);
    if (how) waiting.set(message, { request: l.requestId, waiting: how });
    if (how || (l.status === 'done' && l.text === STEERED_IN)) notes.add(l.id);
  }
  // Sent to steer, its card not here yet: not read (so the line under it doesn't appear a moment later).
  for (const l of items) if (l.type === 'chat' && l.steer && l.request && !cards.has(l.request)) waiting.set(l.id, { request: l.request, waiting: 'next_step' });
  return { waiting, notes };
}

/**
 * Claude Code stopping at a usage limit: "You've hit your limit · resets 3pm", "You've hit your
 * session limit", "Claude AI usage limit reached|…", "5-hour limit reached ∙ resets 9pm".
 */
const LIMIT = /(you['’]ve hit your (?:[\w-]+ )?limit|usage limit reached|(?:session|weekly|5-hour|opus|sonnet)(?: weekly)? limit reached)/i;

/** Whether a card's words are Claude Code's limit notice (short, so an answer about limits isn't). */
export function isLimitNotice(text: string): boolean {
  const last = text.trim().split(/\n+/).at(-1) ?? '';
  return last.length <= 200 && LIMIT.test(last);
}

/**
 * Claude answered but its run waits on work it left going in the background (sub-agents,
 * background shells): what, so the chat doesn't look finished. Undefined: nothing waits.
 */
export function backgroundWait(items: readonly LogItem[]): string | undefined {
  const card = [...items].reverse().find((l): l is Extract<LogItem, { type: 'agent' }> => l.type === 'agent' && l.status !== 'queued');
  if (!card || ['done', 'error', 'denied'].includes(card.status) || !card.text) return undefined;
  const live = card.subagents.filter((x) => x.status === 'running');
  if (!live.length) return undefined;
  const noun = live.every((x) => x.kind !== 'background') ? 'background agent' : live.every((x) => x.kind === 'background') ? 'background task' : 'background job';
  return `Waiting on ${live.length} ${noun}${live.length === 1 ? '' : 's'} · ${live.map((x) => x.title).join(', ')}`;
}
