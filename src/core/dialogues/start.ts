import type { AgentRef } from '../../protocol.js';
import type { DialogueMode, Participant } from './model.js';

/**
 * Starting a dialogue from the composer (BLG-466), two forms:
 *   @my:claude @my:codex talk about X, 6 turns
 *   /dialogue claude codex cross-reference each other on X, 20k tokens
 *   @my:claude @bob:codex talk about X          (bob's agent: each of its turns is a task to bob)
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
/** `@bob:codex` (a friend's agent), or in /dialogue's words `bob:codex`. */
const THEIRS = /^@?([\w.-]+):([\w.-]+)$/;

/** A friend's agent by their name and its name: the participant, or why not. */
export type FriendAgent = (person: string, agent: string) => Participant | string;

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
export function parseDialogueStart(raw: string, mine: readonly AgentRef[], friend?: FriendAgent): DialogueProposal | DialogueStartError | undefined {
  const text = raw.trim();
  const tokens = text.split(/\s+/);
  /** Your agent's name, or [person, agent] for a friend's. */
  const names: Array<string | readonly [string, string]> = [];
  const theirs = (tok: string): readonly [string, string] | undefined => {
    const m = THEIRS.exec(tok);
    return m && m[1]!.toLowerCase() !== 'my' && friend ? [m[1]!, m[2]!] : undefined;
  };
  let i = 0;
  const command = /^[/:]dialogue$/i.test(tokens[0] ?? '');
  if (command) {
    i = 1;
    for (; i < tokens.length; i++) {
      const tok = tokens[i]!;
      const m = MY.exec(tok);
      const friendOf = m ? undefined : theirs(tok);
      if (friendOf) {
        names.push(friendOf);
        continue;
      }
      const name = m ? m[1]! : tok.replace(/^@/, '');
      if (!m && !agentNamed(name, mine)) break;
      names.push(name);
    }
  } else {
    for (; i < tokens.length; i++) {
      const m = MY.exec(tokens[i] ?? '');
      const friendOf = m ? undefined : theirs(tokens[i] ?? '');
      if (!m && !friendOf) break;
      names.push(m ? m[1]! : friendOf!);
    }
    // One agent is just asking it, and friends' agents alone are theirs to talk: not a dialogue of yours.
    if (names.length < 2 || names.every((n) => typeof n !== 'string')) return undefined;
  }
  const usage = 'Name two of your agents and what they should do: /dialogue claude codex talk about X, 6 turns';
  if (names.length < 2) return { kind: 'error', message: usage };
  const participants: Participant[] = [];
  for (const name of names) {
    if (typeof name !== 'string') {
      const p = friend!(name[0], name[1]);
      if (typeof p === 'string') return { kind: 'error', message: p };
      participants.push(p);
      continue;
    }
    const agent = agentNamed(name, mine);
    if (!agent) return { kind: 'error', message: `You have no agent named “${name}”` };
    participants.push({ agent });
  }
  if (participants.length > 4) return { kind: 'error', message: 'A dialogue has at most four agents' };
  const caps = capsOf(tokens.slice(i).join(' '));
  const { mode, topic } = modeOf(caps.rest);
  if (!topic) return { kind: 'error', message: usage };
  return {
    kind: 'proposal',
    participants,
    topic,
    mode,
    ...(caps.turnCap ? { turnCap: caps.turnCap } : {}),
    ...(caps.budget ? { budget: caps.budget } : {}),
  };
}
