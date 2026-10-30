import { z } from 'zod';
import { AgentRef } from '../../protocol.js';

/**
 * A chaired dialogue (BLG-465): two or more agents talk turn by turn, and Beluga core is the chair.
 * Agents never call each other: the chair relays each final answer as the next prompt, enforces
 * the turn cap, the token budget and Stop, and every turn lands in the room thread.
 *
 * This file is the state machine, pure: each change is a function from a dialogue to the next.
 * The loop that runs turns is chair.ts; saving is chair.ts too (dialogues.json beside plans).
 */

/** talk: read-only conversation · cross-reference: A answers, B critiques, A reconciles · work: full tools in one worktree. */
export const DialogueMode = z.enum(['talk', 'cross-reference', 'work']);
export type DialogueMode = z.infer<typeof DialogueMode>;

/** Decided in BLG-464: after 10 agent turns the chair pauses and asks Continue?. */
export const DEFAULT_TURN_CAP = 10;
/** cross-reference is a fixed template: answer, critique, reconciliation. */
export const CROSS_REFERENCE_TURNS = 3;

export const Participant = z.object({
  agent: AgentRef,
  /** Whose agent it is: unset for the owner's own (a friend's name over the gateway, BLG-468). */
  owner: z.string().min(1).max(80).optional(),
});
export type Participant = z.infer<typeof Participant>;

export const DialogueTurn = z.object({
  /** 1-based among agent turns; a person's interjection carries the number of the turn it came after. */
  n: z.number().int().min(0),
  /** Index into participants, or 'person' for an interjection. */
  by: z.union([z.number().int().min(0), z.literal('person')]),
  /** Who interjected (a person's name), for 'person' turns. */
  name: z.string().max(80).optional(),
  text: z.string().max(200_000),
  tokens: z.number().int().min(0).default(0),
  at: z.number(),
});
export type DialogueTurn = z.infer<typeof DialogueTurn>;

/**
 * running: turns go on · paused: the cap was reached, Continue? · stopped: someone pressed Stop ·
 * ended: an agent called end_dialogue (or a fixed template finished) · budget: the token budget ran out ·
 * failed: a turn couldn't run.
 */
export const DialogueStatus = z.enum(['running', 'paused', 'stopped', 'ended', 'budget', 'failed']);
export type DialogueStatus = z.infer<typeof DialogueStatus>;

export const Dialogue = z.object({
  id: z.string().min(1).max(64),
  topic: z.string().min(1).max(8000),
  mode: DialogueMode,
  participants: z.array(Participant).min(2).max(4),
  /** Agent turns per stretch before Continue? (DEFAULT_TURN_CAP unless overridden at start). */
  turnCap: z.number().int().min(1).max(200),
  /** Pause when this many agent turns are done (grows by turnCap on each Continue). */
  pauseAt: z.number().int().min(1),
  /** Tokens all turns together may spend; unset: no budget. */
  budget: z.number().int().min(1).optional(),
  used: z.number().int().min(0).default(0),
  turns: z.array(DialogueTurn),
  status: DialogueStatus,
  /** Why it isn't running (end_dialogue's reason, who stopped it, the failure). */
  note: z.string().max(1000).optional(),
  /** The room conversation its thread lives in. */
  channel: z.string().max(200).optional(),
  /** Who started it (a person's name). */
  startedBy: z.string().max(80).optional(),
  /** For work mode: the one worktree it runs in. */
  worktree: z.string().max(4096).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Dialogue = z.infer<typeof Dialogue>;

export interface DialogueStart {
  readonly id: string;
  readonly topic: string;
  readonly mode?: DialogueMode;
  readonly participants: readonly Participant[];
  readonly turnCap?: number;
  readonly budget?: number;
  readonly channel?: string;
  readonly startedBy?: string;
  readonly worktree?: string;
}

export class DialogueError extends Error {}

export function createDialogue(start: DialogueStart, now: number): Dialogue {
  if (start.participants.length < 2) throw new DialogueError('A dialogue needs two agents');
  const mode = start.mode ?? 'talk';
  const turnCap = mode === 'cross-reference' ? CROSS_REFERENCE_TURNS : Math.max(1, Math.floor(start.turnCap ?? DEFAULT_TURN_CAP));
  return {
    id: start.id,
    topic: start.topic.trim(),
    mode,
    participants: [...start.participants],
    turnCap,
    pauseAt: turnCap,
    ...(start.budget ? { budget: Math.floor(start.budget) } : {}),
    used: 0,
    turns: [],
    status: 'running',
    ...(start.channel ? { channel: start.channel } : {}),
    ...(start.startedBy ? { startedBy: start.startedBy } : {}),
    ...(start.worktree ? { worktree: start.worktree } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Agent turns done so far. */
export const agentTurns = (d: Dialogue): number => d.turns.filter((t) => t.by !== 'person').length;

/** Whose turn is next (round robin; cross-reference: A, B, A). */
export function nextSpeaker(d: Dialogue): number {
  return agentTurns(d) % d.participants.length;
}

/** The next agent turn's number (1-based). */
export const nextTurn = (d: Dialogue): number => agentTurns(d) + 1;

export const budgetLeft = (d: Dialogue): number | undefined => (d.budget === undefined ? undefined : Math.max(0, d.budget - d.used));

export const isOver = (d: Dialogue): boolean => d.status === 'stopped' || d.status === 'ended' || d.status === 'budget' || d.status === 'failed';

export interface TurnDone {
  readonly text: string;
  readonly tokens: number;
  /** end_dialogue's reason, when the agent called it this turn. */
  readonly ended?: string;
}

/**
 * An agent's turn is in: append it, then the rules in order: end_dialogue, the budget, a fixed
 * template's last turn, the cap (pause, Continue?).
 */
export function turnDone(d: Dialogue, done: TurnDone, now: number): Dialogue {
  if (d.status !== 'running') return d;
  const turn: DialogueTurn = { n: nextTurn(d), by: nextSpeaker(d), text: done.text, tokens: Math.max(0, Math.floor(done.tokens)), at: now };
  const next: Dialogue = { ...d, turns: [...d.turns, turn], used: d.used + turn.tokens, updatedAt: now };
  if (done.ended !== undefined) return { ...next, status: 'ended', note: done.ended || 'An agent ended the dialogue' };
  if (next.budget !== undefined && next.used >= next.budget) return { ...next, status: 'budget', note: `The token budget (${next.budget}) ran out` };
  if (next.mode === 'cross-reference' && agentTurns(next) >= CROSS_REFERENCE_TURNS) return { ...next, status: 'ended', note: 'Cross-reference done' };
  if (agentTurns(next) >= next.pauseAt) return { ...next, status: 'paused', note: `Paused after ${agentTurns(next)} turns: continue?` };
  return next;
}

/** Continue? → yes: another stretch of `more` turns (the cap by default). */
export function continueDialogue(d: Dialogue, now: number, more?: number): Dialogue {
  if (d.status !== 'paused') throw new DialogueError(isOver(d) ? 'This dialogue is over' : 'This dialogue is not paused');
  const { note: _note, ...rest } = d;
  return { ...rest, status: 'running', pauseAt: agentTurns(d) + Math.max(1, Math.floor(more ?? d.turnCap)), updatedAt: now };
}

/** Stop: over at once (a turn in flight is dropped by the chair). */
export function stopDialogue(d: Dialogue, now: number, by?: string): Dialogue {
  if (isOver(d)) return d;
  return { ...d, status: 'stopped', note: by ? `Stopped by ${by}` : 'Stopped', updatedAt: now };
}

/** A turn couldn't run. */
export function failDialogue(d: Dialogue, why: string, now: number): Dialogue {
  if (isOver(d)) return d;
  return { ...d, status: 'failed', note: why.slice(0, 1000), updatedAt: now };
}

/** A person speaks into it: a turn of their own, read by the next agent; it doesn't count toward the cap. */
export function interject(d: Dialogue, text: string, name: string, now: number): Dialogue {
  if (isOver(d)) throw new DialogueError('This dialogue is over');
  const body = text.trim();
  if (!body) throw new DialogueError('Nothing to say');
  return { ...d, turns: [...d.turns, { n: agentTurns(d), by: 'person', name, text: body, tokens: 0, at: now }], updatedAt: now };
}
