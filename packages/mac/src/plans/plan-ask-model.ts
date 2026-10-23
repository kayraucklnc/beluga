import type { PendingQuestion } from '../../../../src/core/collab-store.js';

/** How a multi-select's picks so far are kept on the question (see src/ui/collab-actions.ts). */
const MULTI = '#multi';
const SEP = '\u0000';

/** The options picked so far on one question of a card (a multi-select's ticks). */
export function chosenOf(q: Pick<PendingQuestion, 'picked'>, question: string): ReadonlySet<string> {
  return new Set((q.picked[`${question}${MULTI}`] ?? '').split(SEP).filter(Boolean));
}

/** The question the plan's conversation answers right there: the first one asked in it (yours to decide first). */
export function planAskOf(questions: readonly PendingQuestion[], channel: string): PendingQuestion | undefined {
  const here = questions.filter((q) => q.channel === channel && q.question.kind === 'question');
  return here.find((q) => q.qid.startsWith('decide:')) ?? here[0];
}

/** "Decide…" on a task of yours (the canvas, the outline, its details): the plan's page opens its conversation, where the card asks you. */
export const OPEN_DECISION = 'beluga:plan-open-decision';

export const openDecision = (): void => void document.dispatchEvent(new CustomEvent(OPEN_DECISION));
