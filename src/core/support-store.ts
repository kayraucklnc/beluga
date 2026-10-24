/**
 * Supporting Beluga, in the shared state: how many worktrees Beluga made have been merged (here,
 * through a GitHub pull request, or by git some other way), and which of the two asks is due now.
 * The first merge asks for a star on GitHub; the fifth for a coffee, which "Not now" puts off for
 * five more merges, once. Each asks only once otherwise. The record itself (which branches counted,
 * what you answered) is kept in ~/.beluga/support.json (core/merge-counter.ts). Browser-safe: the
 * Mac app runs it.
 */

export type SupportAsk = 'star' | 'coffee';
/** `yes`: starred, or opened a payment page; `later`: Maybe Later / Not Now; `never`: Don't Ask Again. */
export type SupportAnswer = 'yes' | 'later' | 'never';

/** The merges that ask: the first for a star, the fifth for a coffee. */
export const STAR_AT = 1;
export const COFFEE_AT = 5;
/** "Not now" on the coffee asks again this many merges later (once). */
export const COFFEE_SNOOZE = 5;

/** An ask you answered: at how many merges, and how. */
export interface Answered {
  readonly merges: number;
  readonly answer: SupportAnswer;
  /** How many times it was shown (the coffee can come back once after Not Now). */
  readonly times: number;
  readonly at: number;
}

/** What support.json holds. */
export interface SupportRecord {
  /** Merged branches already counted, as `<project folder>#<branch>`: each counts once. */
  readonly counted: readonly string[];
  readonly star?: Answered;
  readonly coffee?: Answered;
}

export const EMPTY_SUPPORT: SupportRecord = { counted: [] };

/** One merged branch's key in `counted`. */
export const mergeKey = (root: string, branch: string): string => `${root}#${branch}`;

/**
 * The ask due now, if any. The star comes first; the coffee only once the star was answered at
 * fewer merges than now (never both after the same merge), then again five merges after Not Now.
 */
export function dueAsk(record: SupportRecord): SupportAsk | undefined {
  const merges = record.counted.length;
  if (!record.star) return merges >= STAR_AT ? 'star' : undefined;
  if (merges < COFFEE_AT || merges <= record.star.merges) return undefined;
  const coffee = record.coffee;
  if (!coffee) return 'coffee';
  if (coffee.answer === 'later' && coffee.times < 2 && merges >= coffee.merges + COFFEE_SNOOZE) return 'coffee';
  return undefined;
}

/** The record after you answered an ask (`now`: epoch ms). */
export function answerAsk(record: SupportRecord, ask: SupportAsk, answer: SupportAnswer, now: number): SupportRecord {
  const before = record[ask];
  return { ...record, [ask]: { merges: record.counted.length, answer, times: (before?.times ?? 0) + 1, at: now } };
}

/** What screens see. */
export interface SupportView {
  /** Worktrees Beluga made that ended up merged. */
  readonly merges: number;
  /** The ask to show now. */
  readonly due?: SupportAsk;
  readonly starShown: boolean;
  readonly coffeeShown: boolean;
}

export const supportView = (record: SupportRecord): SupportView => {
  const due = dueAsk(record);
  return { merges: record.counted.length, ...(due ? { due } : {}), starShown: Boolean(record.star), coffeeShown: Boolean(record.coffee) };
};

export interface SupportSlice {
  readonly support: SupportView;
}

export const initialSupport: SupportSlice = { support: { merges: 0, starShown: false, coffeeShown: false } };

export type SupportAction = { type: 'support'; support: SupportView };
