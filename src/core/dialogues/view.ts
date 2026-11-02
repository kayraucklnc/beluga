import { type Dialogue, agentTurns, budgetLeft, isOver, nextSpeaker } from './model.js';
import { speakerName } from './prompt.js';

/**
 * A dialogue's header card, in words (BLG-466): what the Mac's card and the phone's thread show.
 * Browser-safe (zod and words only).
 */

export type DialogueAction = 'start' | 'cancel' | 'continue' | 'stop';

export interface DialogueHeader {
  readonly id: string;
  readonly topic: string;
  /** "Talk", "Cross-reference", "Work". */
  readonly mode: string;
  /** "Claude and Codex". */
  readonly who: string;
  /** "Turn 3 of 6" (a proposal: "Up to 6 turns"). */
  readonly progress: string;
  /** "12k tokens left" / "Budget 20k tokens"; unset: no budget. */
  readonly budget?: string;
  /** What's happening: "Codex is answering…", "Paused: continue?", "Ended: we agree". */
  readonly status: string;
  readonly tone: 'live' | 'waiting' | 'done' | 'failed';
  /** The buttons, the main one first. */
  readonly actions: readonly DialogueAction[];
}

const MODE_WORDS: Readonly<Record<Dialogue['mode'], string>> = { talk: 'Talk', 'cross-reference': 'Cross-reference', work: 'Work' };

/** 20000 → "20k", 1500000 → "1.5M". */
export function tokenWords(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function dialogueHeader(d: Dialogue): DialogueHeader {
  const names = d.participants.map((_, i) => speakerName(d, i));
  const who = names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and ');
  const done = agentTurns(d);
  const left = budgetLeft(d);
  const proposed = d.status === 'proposed';
  const budget = d.budget === undefined ? undefined : proposed ? `Budget ${tokenWords(d.budget)} tokens` : `${tokenWords(left ?? 0)} tokens left`;
  const progress = proposed ? (d.mode === 'cross-reference' ? 'Answer, critique, reconcile' : `Up to ${d.turnCap} turns, then Continue?`) : d.status === 'running' ? `Turn ${done + 1} of ${d.pauseAt}` : `${done} of ${d.pauseAt} turns`;
  const note = d.note ? `: ${d.note}` : '';
  const status =
    d.status === 'proposed'
      ? 'Start when the caps look right'
      : d.status === 'running'
        ? d.remoteChair
          ? `Chaired by ${d.remoteChair.name}`
          : `${names[nextSpeaker(d)]} is answering…`
        : d.status === 'paused'
          ? `Paused after ${done} turns: continue?`
          : d.status === 'ended'
            ? `Ended${note}`
            : d.status === 'stopped'
              ? `Stopped${d.note?.startsWith('Stopped by') ? d.note.slice('Stopped'.length) : ''}`
              : d.status === 'budget'
                ? 'Halted: the token budget ran out'
                : `Failed${note}`;
  const tone = d.status === 'failed' ? 'failed' : isOver(d) ? 'done' : d.status === 'running' ? 'live' : 'waiting';
  // A friend chairs it: you can stop it on your side (it ends for both), never steer its caps.
  const actions: DialogueAction[] = d.remoteChair ? (isOver(d) ? [] : ['stop']) : d.status === 'proposed' ? ['start', 'cancel'] : d.status === 'paused' ? ['continue', 'stop'] : d.status === 'running' ? ['stop'] : [];
  return { id: d.id, topic: d.topic, mode: MODE_WORDS[d.mode], who, progress, ...(budget ? { budget } : {}), status, tone, actions };
}
