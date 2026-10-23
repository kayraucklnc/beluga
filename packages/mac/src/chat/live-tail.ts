// Relative paths (not @beluga/…) so the unit tests at the repo root can load this model too.
import type { LogItem } from '../../../../src/core/store.js';
import type { StepSummary } from '../../../../src/shared/steps.js';
import { READS_AFTER_STEP, STEERED_IN, backgroundWait } from '../../../../src/shared/claude-notices.js';
import { HIDDEN_STEPS, isRunning } from '../../../../src/ui/format.js';

/**
 * Where a Claude turn is drawn when you said something while it worked (BLG-22). Messages sent
 * mid-turn (steered in, or waiting their turn) land below the turn's card, so the card would sit
 * above them looking stuck while Claude goes on. Instead the turn is drawn in two parts: its
 * head stays where the turn began, with the steps it had finished before your first message;
 * its tail (what it does since: the step it's on, background work, the working line, its
 * answer) comes after what you said: at the very bottom while it runs, and stays there once it
 * has answered, so nothing jumps or vanishes when the turn ends.
 */

type AgentItem = Extract<LogItem, { type: 'agent' }>;

/** The least a chat row needs here (a log item, or a task drawn in the chat). */
export interface RowLike {
  readonly type: string;
  readonly id: string;
  readonly ts: number;
}

/** Which part of a split turn a row draws: the head (where it began) or the tail (after what was said since). */
export interface TurnPart {
  readonly side: 'head' | 'tail';
  /** When the first message said during the turn came: the head keeps the steps finished before it. */
  readonly cut: number;
}

/** A row as the chat draws it: a whole row, or one part of a split turn (keyed apart). */
export interface Shown<R extends RowLike> {
  readonly row: R;
  readonly key: string;
  readonly part?: TurnPart;
}

const isAgent = (r: RowLike): r is RowLike & AgentItem => r.type === 'agent';

/** A card that's a note about a message (queued, read mid-turn, about to be read), not a turn of its own. */
export function isTurnNote(card: Pick<AgentItem, 'status' | 'text'>): boolean {
  return card.status === 'queued' || card.text === STEERED_IN || card.text === READS_AFTER_STEP;
}

/** A turn Claude is working on now (not waiting in the queue, not a note). */
export function isLiveTurn(card: Pick<AgentItem, 'status' | 'text'>): boolean {
  return isRunning(card.status) && !isTurnNote(card);
}

/**
 * The chat's rows with each turn that had things said during it split in two: its head in
 * place, its tail after them (the very end while it runs). A turn nobody spoke during is drawn
 * whole, as before. What counts as said during a turn: rows after its card from before it ended
 * (messages, notes about them, tasks, system lines), up to the next turn of its own.
 */
export function withLiveTails<R extends RowLike>(rows: readonly R[]): Shown<R>[] {
  /** Tails to draw after a row's index; -1: at the very end. */
  const after = new Map<number, Shown<R>[]>();
  const heads = new Map<number, Shown<R>>();
  rows.forEach((row, i) => {
    if (!isAgent(row) || isTurnNote(row)) return;
    const live = isLiveTurn(row);
    const end = live ? Infinity : row.endTs;
    if (end === undefined) return;
    let first = -1;
    let last = -1;
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j]!;
      if (isAgent(r) && !isTurnNote(r)) {
        // Another turn: a finished one's tail goes before it; a running one's still goes to the end.
        if (!live) break;
        continue;
      }
      if (r.ts >= end) break;
      if (first < 0) first = j;
      last = j;
    }
    if (first < 0) return;
    const cut = rows[first]!.ts;
    heads.set(i, { row, key: row.id, part: { side: 'head', cut } });
    const at = live ? -1 : last;
    after.set(at, [...(after.get(at) ?? []), { row, key: `${row.id}:tail`, part: { side: 'tail', cut } }]);
  });
  if (!heads.size) return rows.map((row) => ({ row, key: row.id }));
  const out: Shown<R>[] = [];
  rows.forEach((row, i) => {
    out.push(heads.get(i) ?? { row, key: row.id });
    out.push(...(after.get(i) ?? []));
  });
  out.push(...(after.get(-1) ?? []));
  return out;
}

/** When a step ended (its start, when it never said). */
const endOf = (step: StepSummary): number => step.endedAt ?? (step.durationMs !== undefined ? step.startedAt + step.durationMs : step.startedAt);

/**
 * Whether a step of a split turn is drawn in its head: it had finished before the first message
 * said during the turn. One still running, or finishing after it, is the tail's; so are one-line
 * steps without times (a friend's Claude), which can't be placed.
 */
export function inHead(step: StepSummary, cut: number): boolean {
  if (step.id.startsWith('line-') || step.status === 'running') return false;
  return endOf(step) <= cut;
}

/**
 * The working line at the bottom of a turn Claude is on: what it's doing in a few words, or ''
 * while a step runs (the step's own row, just above, says which). Undefined: no working line
 * (waiting for an approval, or not working).
 */
export function workingPhase(card: AgentItem): string | undefined {
  if (!isLiveTurn(card) || card.status === 'awaiting_approval') return undefined;
  // Answered, but its run waits on work it left going in the background.
  const waiting = backgroundWait([card]);
  if (waiting) return waiting;
  if (card.between === 'writing' || (card.text && !card.between)) return 'Writing';
  if (card.between === 'thinking') return 'Thinking';
  if (card.steps.some((x) => !HIDDEN_STEPS.test(x))) return '';
  const subs = card.subagents.filter((x) => x.status === 'running').length;
  return subs ? `${subs} sub-agent${subs === 1 ? '' : 's'} at work` : 'Starting';
}
