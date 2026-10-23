/**
 * A task's acceptance criteria: "- [ ]" lines in its brief. One that isn't ticked can carry a short
 * reason on its own line ("- [ ] The e2e passes — deferred: suites run at the end of the plan", or
 * "— not done: …"), so every criterion is met or explained before the task goes to review.
 */

export type CriterionState = 'done' | 'deferred' | 'not_done' | 'open';

export interface Criterion {
  /** What must be true (without its reason). */
  readonly text: string;
  readonly state: CriterionState;
  /** Why it isn't ticked (deferred or not done). */
  readonly reason?: string;
}

const BOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/;
// "— deferred: why", "-- not done: why", "(deferred: why)".
const WHY = /\s*(?:[—–]|--|\s-|\(|·)\s*(deferred|not done)\s*:\s*(.+?)\)?\s*$/i;

/** One checklist line, or undefined for any other line. */
export function parseCriterion(line: string): Criterion | undefined {
  const m = BOX.exec(line);
  if (!m) return undefined;
  const body = (m[2] ?? '').trim();
  const why = WHY.exec(body);
  const text = why ? body.slice(0, why.index).trim() : body;
  if (m[1] !== ' ') return { text, state: 'done' };
  if (!why) return { text, state: 'open' };
  return { text, state: why[1]!.toLowerCase() === 'deferred' ? 'deferred' : 'not_done', reason: why[2]!.trim() };
}

export function criteria(text: string | undefined): Criterion[] {
  return (text ?? '').split('\n').flatMap((l) => {
    const c = parseCriterion(l);
    return c ? [c] : [];
  });
}

export interface Tally {
  readonly done: number;
  readonly deferred: number;
  readonly notDone: number;
  /** Neither ticked nor explained. */
  readonly open: number;
  readonly total: number;
}

export function tally(text: string | undefined): Tally {
  const all = criteria(text);
  const n = (s: CriterionState): number => all.filter((c) => c.state === s).length;
  return { done: n('done'), deferred: n('deferred'), notDone: n('not_done'), open: n('open'), total: all.length };
}

/** Criteria neither ticked nor given a reason: these keep a task out of review. */
export const unexplained = (text: string | undefined): Criterion[] => criteria(text).filter((c) => c.state === 'open');

/** A criterion as its checklist line. */
export function criterionLine(c: Criterion): string {
  if (c.state === 'done') return `- [x] ${c.text}`;
  if (c.state === 'open' || !c.reason) return `- [ ] ${c.text}`;
  return `- [ ] ${c.text} — ${c.state === 'deferred' ? 'deferred' : 'not done'}: ${c.reason}`;
}

/** "4/5 · 1 deferred": how far a checklist is, in a few words. */
export function tallyWords(t: Tally): string {
  return [`${t.done}/${t.total}`, t.deferred ? `${t.deferred} deferred` : '', t.notDone ? `${t.notDone} not done` : ''].filter(Boolean).join(' · ');
}

/** Why a task can't go to review yet, for its Claude: which criteria, and how to settle them. */
export function needsChecksText(key: string, open: readonly Criterion[]): string {
  return [
    `${key} can't go to review yet: ${open.length === 1 ? 'this criterion is' : `${open.length} criteria are`} neither ticked nor explained:`,
    ...open.map((c) => `- ${c.text}`),
    'Tick each one that is true ("- [x]") with task_brief_edit, or give it a short reason on its line ("- [ ] … — deferred: suites run at the end of the plan", "- [ ] … — not done: why"). Then try again.',
  ].join('\n');
}
