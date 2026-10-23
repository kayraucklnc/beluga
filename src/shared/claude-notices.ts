import type { LogItem } from '../core/store.js';

/**
 * Words about a Claude card that aren't Claude's answer: Claude Code's own notice that a plan
 * limit was hit, klaud's note on a queued message Claude read mid-turn, and what an answered
 * turn still waits on. Browser-safe (the core writes them, the Mac app shows them).
 */

/** What a steered message's card says while it waits in the running turn for Claude's next step. */
export const READS_AFTER_STEP = 'Claude reads this after its current step';

/** What a queued message's card says when Claude took it in while it worked (see AgentHost.steer). */
export const STEERED_IN = 'Claude read this while it worked; the answer above covers it.';

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
