import type { AgentRef } from '../../protocol.js';
import type { DialogueMode, Participant } from './model.js';

/**
 * Starting a dialogue from the composer (BLG-466), two forms:
 *   @my:claude @my:codex talk about X, 6 turns
 *   /dialogue claude codex cross-reference each other on X, 20k tokens
 * Two (or more) of your agents, then what to do: "talk about…" (talk, the default),
 * "cross-reference each other on…", "work on…". Caps: "N turns", "Nk tokens". Nothing here
 * starts anything: the chair proposes it and you confirm its caps.
 */

export interface DialogueProposal {
  readonly kind: 'proposal';
  readonly participants: readonly Participant[];
  readonly topic: string;
  readonly mode: DialogueMode;
  readonly turnCap?: number;
  readonly budget?: number;
}

export interface DialogueStartError {
  readonly kind: 'error';
  readonly message: string;
}

const MY = /^@my:([\w.-]+)$/i;

/** One of your agents by its name or its runtime ("Codex", "codex"). */
function agentNamed(name: string, mine: readonly AgentRef[]): AgentRef | undefined {
  const n = name.toLowerCase();
  return mine.find((a) => a.label.toLowerCase() === n) ?? mine.find((a) => a.runtime.toLowerCase() === n);
}

/** "6 turns", "20k tokens", "budget 1.5m tokens" out of the words → the caps and what's left. */
export function capsOf(text: string): { readonly rest: string; readonly turnCap?: number; readonly budget?: number } {
  let rest = text;
  let turnCap: number | undefined;
  let budget: number | undefined;
  rest = rest.replace(/[,;]?\s*(?:for\s+|in\s+|max\s+)?(\d{1,3})\s*turns?\b/i, (_, n: string) => {
    turnCap = Number(n);
    return '';
  });
  rest = rest.replace(/[,;]?\s*(?:a\s+)?(?:budget\s+(?:of\s+)?)?(\d+(?:\.\d+)?)\s*(k|m)?\s*tokens?(?:\s+budget)?\b/i, (_, n: string, unit?: string) => {
    budget = Math.round(Number(n) * (unit?.toLowerCase() === 'm' ? 1_000_000 : unit?.toLowerCase() === 'k' ? 1_000 : 1));
    return '';
  });
  return { rest: rest.replace(/\s+/g, ' ').replace(/[\s,;.]+$/, '').trim(), ...(turnCap ? { turnCap } : {}), ...(budget ? { budget } : {}) };
}

/** What to do, from the words after the agents: the mode and the topic. */
export function modeOf(text: string): { readonly mode: DialogueMode; readonly topic: string } {
  const t = text.trim();
  const xref = /^(?:please\s+)?(?:you\s+(?:two|all)[,\s]+)?cross[-\s]?reference(?:\s+each\s+other)?(?:\s+(?:on|about|for))?[:,\s]*/i.exec(t);
  if (xref) return { mode: 'cross-reference', topic: t.slice(xref[0].length).trim() };
  const work = /^(?:please\s+)?(?:work|build)(?:\s+together)?(?:\s+on)?[:,\s]+/i.exec(t);
  if (work) return { mode: 'work', topic: t.slice(work[0].length).trim() };
  const talk = /^(?:please\s+)?(?:you\s+(?:two|all)[,\s]+)?(?:talk|discuss|debate|chat)(?:\s+(?:about|over|on))?[:,\s]*/i.exec(t);
  return { mode: 'talk', topic: (talk ? t.slice(talk[0].length) : t).trim() };
}

/**
 * A line from the composer that starts a dialogue → its proposal (or what's wrong with it);
 * undefined when it isn't one (any other message goes on as before).
 */
export function parseDialogueStart(raw: string, mine: readonly AgentRef[]): DialogueProposal | DialogueStartError | undefined {
  const text = raw.trim();
  const tokens = text.split(/\s+/);
  const names: string[] = [];
  let i = 0;
  const command = /^[/:]dialogue$/i.test(tokens[0] ?? '');
  if (command) {
    i = 1;
    for (; i < tokens.length; i++) {
      const tok = tokens[i]!;
      const m = MY.exec(tok);
      const name = m ? m[1]! : tok.replace(/^@/, '');
      if (!m && !agentNamed(name, mine)) break;
      names.push(name);
    }
  } else {
    for (; i < tokens.length; i++) {
      const m = MY.exec(tokens[i] ?? '');
      if (!m) break;
      names.push(m[1]!);
    }
    // One @my: is just asking that agent: not a dialogue.
    if (names.length < 2) return undefined;
  }
  const usage = 'Name two of your agents and what they should do: /dialogue claude codex talk about X, 6 turns';
  if (names.length < 2) return { kind: 'error', message: usage };
  const agents: AgentRef[] = [];
  for (const name of names) {
    const agent = agentNamed(name, mine);
    if (!agent) return { kind: 'error', message: `You have no agent named “${name}”` };
    agents.push(agent);
  }
  if (agents.length > 4) return { kind: 'error', message: 'A dialogue has at most four agents' };
  const caps = capsOf(tokens.slice(i).join(' '));
  const { mode, topic } = modeOf(caps.rest);
  if (!topic) return { kind: 'error', message: usage };
  return {
    kind: 'proposal',
    participants: agents.map((agent) => ({ agent })),
    topic,
    mode,
    ...(caps.turnCap ? { turnCap: caps.turnCap } : {}),
    ...(caps.budget ? { budget: caps.budget } : {}),
  };
}
