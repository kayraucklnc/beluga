import type { BoardState } from '../../../../src/core/board/model.js';
import type { Actor } from '../../../../src/core/board/model.js';
import { AUTONOMY_INFO, type Autonomy, type Plan, type PlanBody, type PlanEvent, type PlansState, diffBodies, milestoneDeps, planTitle, shownBody } from '../../../../src/core/plans/model.js';
import type { MilestoneState, MilestoneView, NextStep, PlanView, TaskState, TaskView } from '../../../../src/core/plans/progress.js';
import { pulseWords } from '../../../../src/core/plans/watchdog.js';

/**
 * The Plans screens' pure parts (no DOM): words and tones for states, what a plan waits for as a
 * button, the plans of a project in the order they're shown, and the plan graph's structure (what
 * the layout depends on, kept apart from the live state so a task moving on never re-lays it out).
 */

export type Tone = 'muted' | 'neutral' | 'claude' | 'info' | 'ok' | 'warn' | 'error' | 'accent';

export const TASK_STATE: Readonly<Record<TaskState, { readonly label: string; readonly tone: Tone }>> = {
  draft: { label: 'Draft', tone: 'muted' },
  later: { label: 'Later', tone: 'muted' },
  blocked: { label: 'Waiting', tone: 'muted' },
  ready: { label: 'Ready', tone: 'accent' },
  running: { label: 'Working', tone: 'claude' },
  asking: { label: 'Waiting for you', tone: 'warn' },
  idle: { label: 'Stopped without finishing', tone: 'warn' },
  stalled: { label: 'Needs you', tone: 'warn' },
  review: { label: 'In review', tone: 'info' },
  planned: { label: 'Merged into plan', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  canceled: { label: 'Canceled', tone: 'muted' },
  missing: { label: 'Deleted', tone: 'muted' },
};

export const MILESTONE_STATE: Readonly<Record<MilestoneState, { readonly label: string; readonly tone: Tone }>> = {
  draft: { label: 'Draft', tone: 'muted' },
  later: { label: 'Up next', tone: 'muted' },
  running: { label: 'In progress', tone: 'claude' },
  checking: { label: 'Claude is checking', tone: 'claude' },
  gate: { label: 'Ready to pass', tone: 'accent' },
  failed: { label: 'Check failed', tone: 'error' },
  merging: { label: 'Merging into the plan', tone: 'claude' },
  passed: { label: 'Passed', tone: 'ok' },
};

/**
 * A milestone's status text in the plan's list: its state, plus when it runs. Open milestones say
 * they run side by side with the others open now; a waiting one says what it waits on.
 */
export function milestoneLabel(view: Pick<PlanView, 'milestones' | 'open'>, m: MilestoneView): string {
  const base = MILESTONE_STATE[m.state].label;
  const title = (id: string): string => `“${view.milestones.find((x) => x.milestone.id === id)?.milestone.title ?? id}”`;
  if (m.state === 'later') {
    const waits = m.dependsOn.filter((d) => view.milestones.find((x) => x.milestone.id === d)?.state !== 'passed');
    return waits.length ? `After ${waits.map(title).join(' and ')}` : base;
  }
  const beside = view.open.filter((x) => x.milestone.id !== m.milestone.id);
  if (!view.open.some((x) => x.milestone.id === m.milestone.id) || !beside.length) return base;
  return `${base} · alongside ${beside.length > 2 ? `${beside.length} others` : beside.map((x) => title(x.milestone.id)).join(' and ')}`;
}

/** How a plan is, in one word, for lists and the page's header. */
export function planStatus(view: Pick<PlanView, 'plan' | 'next'>): { readonly label: string; readonly tone: Tone } {
  const { plan, next } = view;
  if (!plan.body) return { label: 'Draft', tone: 'muted' };
  if (plan.status === 'done' && !plan.draft) return next.kind === 'ship' ? { label: plan.pr?.state === 'CLOSED' ? 'PR closed' : plan.pr ? 'PR open' : 'Ready to ship', tone: plan.pr?.state === 'CLOSED' ? 'warn' : 'accent' } : { label: 'Done', tone: 'ok' };
  if (plan.draft) return { label: 'Changes proposed', tone: 'accent' };
  if (plan.paused) return { label: 'Paused', tone: 'muted' };
  switch (next.kind) {
    case 'pass':
    case 'start':
    case 'answer':
    case 'stalled':
      return { label: 'Waiting for you', tone: 'accent' };
    case 'failed':
      return { label: 'Needs a fix', tone: 'error' };
    case 'checking':
      return { label: 'Checking', tone: 'claude' };
    case 'merging':
      return next.milestone.merging?.conflict?.stuck ? { label: 'Waiting for you', tone: 'accent' } : { label: 'Merging', tone: 'claude' };
    case 'working':
      return { label: 'Running', tone: 'claude' };
    default:
      return { label: 'Waiting', tone: 'muted' };
  }
}

/**
 * A task's state in words for its card: a started task says how it's doing right now (“Working”
 * with its step and how long, “Running a long command · 12m”, “Stopped without finishing”), never
 * “working” when no turn runs.
 */
export function taskWords(t: TaskView, now: number): { readonly label: string; readonly tone: Tone; readonly sub?: string } {
  const base = TASK_STATE[t.state];
  if (!t.pulse || t.combining) return { ...base, ...(t.state === 'running' && t.step ? { sub: t.step } : t.state === 'blocked' || t.state === 'later' ? (t.why ? { sub: t.why } : {}) : {}) };
  const w = pulseWords(t.pulse, now);
  // Woken: the card says so while it works again.
  const sub = t.watch && !t.watch.needsYou && t.pulse.kind !== 'stopped' && t.pulse.kind !== 'waiting' ? `${w.sub ?? ''}${w.sub ? ' · ' : ''}${t.watch.line}` : w.sub;
  return { label: w.label, tone: w.tone, ...(sub ? { sub } : {}) };
}

/** The one thing to do next, in words (the page's main button and its line). */
export function nextWords(next: NextStep): { readonly title: string; readonly detail?: string } {
  switch (next.kind) {
    case 'approve':
      return { title: 'Approve Plan', detail: 'Its tasks go on the board and the plan starts' };
    case 'review_changes':
      return { title: 'Apply Changes', detail: 'Claude proposed changes to the plan' };
    case 'resume':
      return { title: 'Resume', detail: 'Paused: nothing starts until you resume it' };
    case 'start': {
      // Yours: no worktree, you answer it in the plan's conversation (see core/plans/decisions.ts).
      const yours = next.tasks.filter((t) => t.forYou);
      if (yours.length === next.tasks.length) return { title: yours.length === 1 ? `Answer “${yours[0]!.task.title}”` : `Answer ${yours.length} Decisions`, detail: 'Yours: answer in the plan’s conversation, and it carries on' };
      const claude = next.tasks.length - yours.length;
      return { title: claude === 1 ? `Start “${next.tasks.find((t) => !t.forYou)!.task.title}”` : `Start ${claude} Tasks`, detail: claude === 1 ? 'Ready to go' : 'Ready to go, side by side' };
    }
    case 'pass':
      return { title: `Pass “${next.milestone.milestone.title}”`, detail: next.milestone.run.check ? (next.milestone.run.check.verdict === 'pass' ? 'Claude checked it: every criterion holds' : 'Claude’s check found problems') : 'Every task is finished' };
    case 'checking':
      return { title: 'Claude is checking', detail: `The pass criteria of “${next.milestone.milestone.title}”` };
    case 'failed':
      return { title: 'Needs a fix', detail: `“${next.milestone.milestone.title}” didn’t pass Claude’s check` };
    case 'answer':
      return { title: 'Claude asked something', detail: next.tasks.map((t) => t.issue?.key ?? t.task.title).join(', ') };
    case 'stalled':
      return { title: next.tasks.length === 1 ? `Resume ${next.tasks[0]!.issue?.key ?? `“${next.tasks[0]!.task.title}”`}` : `Resume ${next.tasks.length} Tasks`, detail: next.tasks.map((t) => t.watch?.line ?? `${t.issue?.key ?? t.task.title} stopped again`).join(' · ') };
    case 'working':
      return { title: next.tasks.length ? `${next.tasks.length} ${next.tasks.length === 1 ? 'task' : 'tasks'} in progress` : 'Starting…', ...(next.note ? { detail: next.note } : {}) };
    case 'waiting':
      return { title: 'Waiting', detail: next.why };
    case 'merging':
      return { title: next.text, detail: `“${next.milestone.milestone.title}” passes once its work is merged into the plan’s branch` };
    case 'ship':
      if (next.pr?.state === 'OPEN') return { title: `Pull request #${next.pr.number} is open`, detail: `${next.branch} → main: its tasks are Done once it merges` };
      if (next.pr?.state === 'CLOSED') return { title: `Pull request #${next.pr.number} was closed`, detail: 'Closed without merging: the plan’s tasks stay merged into the plan' };
      return { title: 'Open PR', detail: `Every milestone passed: ${next.branch} has all the plan’s work` };
    case 'done':
      return { title: 'Done', detail: 'Every milestone passed' };
  }
}

/** A project's plans: running first, then drafts, then finished; newest first in each. */
export function plansOf(state: PlansState, projectId: string | undefined): Plan[] {
  const rank = (p: Plan): number => (p.status === 'active' ? 0 : p.status === 'draft' ? 1 : 2);
  return state.plans.filter((p) => p.projectId === projectId).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}

export const titleOf = planTitle;

/** How far along each milestone is, for a plan's progress bar (finished share per milestone). */
export function bars(view: PlanView): ReadonlyArray<{ readonly id: string; readonly title: string; readonly state: MilestoneState; readonly share: number }> {
  return view.milestones.map((m) => ({ id: m.milestone.id, title: m.milestone.title, state: m.state, share: m.state === 'passed' ? 1 : m.total ? m.finished / m.total : 0 }));
}

/**
 * Milestones in rows by what they wait on: the first row waits on nothing, each next row on the
 * rows before it. Milestones in one row run side by side (ids, in the plan's order).
 */
export function milestoneRows(body: PlanBody | undefined): ReadonlyArray<readonly string[]> {
  const ms = body?.milestones ?? [];
  const depth = new Map<string, number>();
  const of = (id: string, seen: ReadonlySet<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const m = ms.find((x) => x.id === id);
    if (!m || seen.has(id)) return 0;
    const d = Math.max(-1, ...milestoneDeps(body, m).map((x) => of(x, new Set([...seen, id])))) + 1;
    depth.set(id, d);
    return d;
  };
  const rows: string[][] = [];
  for (const m of ms) (rows[of(m.id, new Set())] ??= []).push(m.id);
  return rows.filter(Boolean);
}

/** The plan's progress bar: one column per row of milestones, the milestones of a row stacked in it (side by side in time). */
export function barColumns(view: PlanView): ReadonlyArray<ReturnType<typeof bars>> {
  const all = new Map(bars(view).map((b) => [b.id, b]));
  return milestoneRows(view.body ?? shownBody(view.plan)).map((row) => row.flatMap((id) => all.get(id) ?? []));
}

// ---- the plan's one sentence

/** Who a sentence is about: you (something waits for you), Claude (it's at work), Beluga (the plan itself). */
export type Who = 'you' | 'claude' | 'beluga';

export interface Headline {
  readonly who: Who;
  readonly text: string;
}

/** The plan's branch bits, when the plan carries them (plan-branch-flow): read loosely. */
interface BranchBits {
  readonly branch?: string;
  readonly merging?: Readonly<Record<string, { readonly catchUp?: boolean; readonly conflict?: { readonly key?: string; readonly merging?: string; readonly files?: readonly string[]; readonly stuck?: boolean } }>>;
}
const branchBits = (plan: Plan): BranchBits => plan as Plan & BranchBits;

const quoted = (m: MilestoneView): string => `“${m.milestone.title}”`;
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What's merging into the plan's branch now, when the plan carries that (a conflict first). */
function mergingLine(view: PlanView): Headline | undefined {
  const merging = branchBits(view.plan).merging ?? {};
  const entries = Object.entries(merging).filter(([, m]) => !m.catchUp);
  const conflict = entries.find(([, m]) => m.conflict);
  if (conflict) {
    const c = conflict[1].conflict!;
    const what = c.key ?? c.merging ?? 'the plan’s branch';
    return c.stuck ? { who: 'you', text: `Fix the merge conflict in ${what}${c.files?.length ? ` (${c.files.slice(0, 2).join(', ')})` : ''}` } : { who: 'claude', text: `Fixing a merge conflict in ${what}` };
  }
  const first = entries[0];
  if (!first) return undefined;
  const m = view.milestones.find((x) => x.milestone.id === first[0]);
  return { who: 'beluga', text: `Merging ${m ? quoted(m) : 'a milestone'} into ${branchBits(view.plan).branch ?? 'the plan’s branch'}` };
}

/**
 * The plan in one sentence, with who it's about: what waits for you (“You: pass “API” — Claude
 * checked all 4 criteria”), else what Claude or Beluga is doing (“Claude is checking “API””, “3
 * tasks running in 2 milestones”).
 */
export function headline(view: PlanView): Headline {
  const { plan, next } = view;
  const running = view.active.filter((t) => t.state === 'running' || t.state === 'idle');
  const inMilestones = new Set(running.map((t) => t.milestoneId)).size;
  const alsoRunning = running.length ? ` · ${count(running.length, 'task')} running` : '';
  if (!plan.body) return view.milestones.length ? { who: 'you', text: `Approve the plan: ${count(view.milestones.length, 'milestone')} · ${count(view.total, 'task')} · a draft, not on the board yet` } : { who: 'claude', text: 'Claude is writing the plan' };
  if (plan.draft) return { who: 'you', text: `Review Claude’s changes: ${changeWords(plan)}` };
  if (next.kind !== 'done' && next.kind !== 'answer' && next.kind !== 'failed') {
    const merging = mergingLine(view);
    if (merging) return merging;
  }
  switch (next.kind) {
    case 'approve':
    case 'review_changes':
      return { who: 'you', text: `Review Claude’s changes: ${changeWords(plan)}` };
    case 'resume':
      return { who: 'you', text: 'Resume the plan: it’s paused, nothing starts' };
    case 'answer':
      return { who: 'you', text: `Answer Claude in ${next.tasks.map((t) => t.issue?.key ?? `“${t.task.title}”`).join(', ')}` };
    case 'failed':
      return { who: 'you', text: `${quoted(next.milestone)} didn’t pass Claude’s check: send it back or pass it anyway` };
    case 'pass': {
      const m = next.milestone;
      const n = m.milestone.criteria.length;
      const why = m.run.check?.verdict === 'pass' ? `Claude checked ${n === 1 ? 'its criterion' : n === 2 ? 'both criteria' : `all ${n} criteria`}` : 'every task is finished';
      return { who: 'you', text: `Pass ${quoted(m)} — ${why}` };
    }
    case 'start':
      return { who: 'you', text: next.tasks.length === 1 ? `Start “${next.tasks[0]!.task.title}”` : `Start ${count(next.tasks.length, 'task')}` };
    case 'checking':
      return { who: 'claude', text: `Claude is checking ${quoted(next.milestone)}${alsoRunning}` };
    case 'working':
      return running.length ? { who: 'claude', text: `${count(running.length, 'task')} running${inMilestones > 1 ? ` in ${inMilestones} milestones` : ''}` } : { who: 'beluga', text: 'Starting the next tasks' };
    case 'waiting':
      return { who: 'beluga', text: next.why };
    case 'merging':
      return { who: next.milestone.merging?.conflict?.stuck ? 'you' : 'beluga', text: next.text };
    case 'stalled':
      return { who: 'you', text: `Resume ${next.tasks.map((t) => t.issue?.key ?? `“${t.task.title}”`).join(', ')}: its Claude stopped again without finishing` };
    case 'ship':
      if (next.pr?.state === 'OPEN') return { who: 'you', text: `Merge #${next.pr.number} on GitHub: every milestone passed` };
      if (next.pr?.state === 'CLOSED') return { who: 'you', text: `#${next.pr.number} was closed without merging: open it again, or merge locally` };
      return { who: 'you', text: `Open the plan’s pull request: ${next.branch} → main` };
    case 'done':
      return { who: 'beluga', text: 'Done: every milestone passed' };
  }
}

/** From a task's worktree: where it stands in its plan, in the same voice as the plan's sentence. */
export function taskHeadline(view: PlanView, taskId: string): Headline | undefined {
  const t = view.milestones.flatMap((m) => m.tasks).find((x) => x.task.id === taskId);
  const m = t && view.milestones.find((x) => x.milestone.id === t.milestoneId);
  if (!t || !m) return undefined;
  const into = 'Beluga merges this into the plan';
  const state = t.state as string;
  if (state === 'planned') return { who: 'beluga', text: 'Merged into the plan; done when the plan’s pull request merges' };
  switch (t.state) {
    case 'running':
      return { who: 'claude', text: t.step ? `Claude is working on this: ${t.step}` : 'Claude is working on this' };
    case 'asking':
      return { who: 'you', text: 'Claude asked you something here' };
    case 'idle':
      return { who: 'beluga', text: 'In progress; nobody is working on it right now' };
    case 'ready':
      if (t.forYou) return { who: 'you', text: 'Yours: answer it in the plan’s conversation (no worktree)' };
      return m.autonomy === 'step' ? { who: 'you', text: 'Ready: start it from the plan' } : { who: 'beluga', text: 'Ready: it starts by itself' };
    case 'blocked':
    case 'later':
      return { who: 'beluga', text: t.why ?? 'Waiting' };
    case 'done':
      return { who: 'beluga', text: m.state === 'passed' ? 'Done and in the plan' : `Done. Waiting for ${quoted(m)} to pass` };
    case 'canceled':
    case 'missing':
      return { who: 'beluga', text: 'Taken out of the plan' };
    case 'draft':
      return { who: 'you', text: 'A draft: approve the plan first' };
    case 'review':
      break;
  }
  // Done here: what's left is the milestone's.
  const others = m.tasks.filter((x) => x !== t && !['review', 'done', 'canceled', 'missing', 'planned'].includes(x.state)).length;
  if (m.state === 'running') return { who: 'beluga', text: `Done. Waiting for ${count(others, 'other task')} of ${quoted(m)}, then the milestone check; ${into}` };
  if (m.state === 'checking' || (m.state === 'gate' && m.milestone.criteria.length && !m.run.check)) return { who: 'claude', text: `Done. Claude is checking ${quoted(m)}; ${into}` };
  if (m.state === 'gate') return m.autonomy === 'autopilot' ? { who: 'beluga', text: `Done. ${quoted(m)} passes by itself; ${into}` } : { who: 'you', text: `Done. Pass ${quoted(m)} in the plan; ${into}` };
  if (m.state === 'failed') return { who: 'you', text: `Done, but ${quoted(m)} didn’t pass Claude’s check` };
  return { who: 'beluga', text: `Done. Waiting for the milestone check; ${into}` };
}

// ---- changing how a plan runs

/** What switching a plan to `to` changes from now on, in plain words (and what happens at once). */
export function modeChange(view: PlanView, to: Autonomy): { readonly title: string; readonly from: string; readonly now?: string } {
  const branch = branchBits(view.plan).branch;
  const label = AUTONOMY_INFO[to].label;
  const from = {
    step: 'From now on nothing starts by itself: you start each task. Tasks already running go on.',
    gated: 'From now on tasks start by themselves, and each milestone waits for you to pass it once Claude has checked it.',
    autopilot: `From now on Claude passes milestones itself${branch ? ` and merges them into ${branch}` : ''}. It stops only if a check fails.`,
  }[to];
  const open = view.open;
  const nowBits: string[] = [];
  if (to === 'autopilot') {
    const passing = open.filter((m) => m.state === 'gate' && (m.run.check?.verdict === 'pass' || !m.milestone.criteria.length));
    if (passing.length) nowBits.push(`${passing.map(quoted).join(' and ')} ${passing.length === 1 ? 'passes' : 'pass'} now`);
  }
  if (to !== 'step') {
    const ready = view.ready.filter((t) => !t.forYou).length;
    const room = Math.max(0, view.plan.maxParallel - view.active.length);
    const starts = Math.min(ready, room);
    if (starts) nowBits.push(`${count(starts, 'ready task')} ${starts === 1 ? 'starts' : 'start'} now`);
  }
  if (view.plan.body?.milestones.some((m) => m.autonomy && m.autonomy !== to)) nowBits.push('milestones you set their own way follow this too');
  const now = nowBits.length ? `${nowBits.join('; ')}.` : undefined;
  return { title: `Switch to ${label}`, from, ...(now ? { now: now[0]!.toUpperCase() + now.slice(1) } : {}) };
}

// ---- what happened

export type FeedKind = 'started' | 'finished' | 'checking' | 'checked' | 'failed' | 'merged' | 'passed' | 'mode' | 'approved' | 'changed' | 'paused' | 'resumed' | 'done' | 'problem';

export interface FeedItem {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly kind: FeedKind;
  /** What happened (the newest of a run of repeats), after the actor's name. */
  readonly text: string;
  /** Repeats folded into it (1: none). */
  readonly count: number;
  /** Every text folded in, newest first. */
  readonly texts: readonly string[];
}

function feedKind(e: PlanEvent): FeedKind | undefined {
  switch (e.kind) {
    case 'started':
    case 'finished':
    case 'checked':
    case 'failed':
    case 'merged':
    case 'approved':
    case 'changed':
    case 'paused':
    case 'resumed':
    case 'done':
    case 'problem':
      return e.kind;
    case 'passed':
      return /^merged\b/.test(e.text) ? 'merged' : 'passed';
    case 'gate':
      return /^checked\b/.test(e.text) ? 'checked' : 'checking';
    case 'autonomy':
      return 'mode';
    default:
      return undefined;
  }
}

/** Repeats this close together are one line. */
const FOLD_MS = 30 * 60 * 1000;

/**
 * What the plan did, newest first: started / finished / checked / merged / passed / the mode
 * changed (and the few other things worth seeing). A run of the same thing by the same one is one
 * line (“Beluga started 3 tasks”); the same line again and again says ×3.
 */
export function feedOf(activity: readonly PlanEvent[]): readonly FeedItem[] {
  const out: FeedItem[] = [];
  for (const e of [...activity].reverse()) {
    const kind = feedKind(e);
    if (!kind) continue;
    const last = out.at(-1);
    const fold = last && last.kind === kind && sameBy(last.by, e.by) && last.at - e.at < FOLD_MS && (last.texts[0] === e.text || kind === 'started' || kind === 'finished');
    if (!fold) {
      out.push({ id: e.id, at: e.at, by: e.by, kind, text: e.text, count: 1, texts: [e.text] });
      continue;
    }
    const texts = [...last.texts, e.text];
    const same = texts.every((x) => x === texts[0]);
    out[out.length - 1] = { ...last, count: texts.length, texts, text: same ? last.texts[0]! : `${kind} ${count(texts.length, 'task')}: ${texts.map((x) => /\b[A-Z][A-Z0-9]*-\d+\b/.exec(x)?.[0] ?? x.replace(/^\w+\s+/, '')).reverse().join(', ')}` };
  }
  return out;
}

const sameBy = (a: Actor, b: Actor): boolean => a.kind === b.kind && (a.kind === 'person' ? a.id === (b as typeof a).id : a.kind === 'claude' ? a.owner === (b as typeof a).owner : true);

/** What a draft changes in an approved plan, per task id (for marks on the graph and outline). */
export function changeMarks(plan: Plan): ReadonlyMap<string, 'added' | 'changed'> {
  if (!plan.body || !plan.draft) return new Map();
  const d = diffBodies(plan.body, plan.draft);
  return new Map([...d.added.map((id) => [id, 'added'] as const), ...d.changed.map((id) => [id, 'changed'] as const)]);
}

export function changeWords(plan: Plan): string {
  const d = diffBodies(plan.body, plan.draft);
  const parts = [d.added.length ? `${d.added.length} new` : '', d.changed.length ? `${d.changed.length} changed` : '', d.removed.length ? `${d.removed.length} taken out` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Milestones changed';
}

// ---- the graph's structure

export interface PlanGraphShape {
  /** Milestones as boxes (in order), each with its tasks and a gate at its end listing its criteria (they size it). */
  readonly milestones: ReadonlyArray<{ readonly id: string; readonly tasks: readonly string[]; readonly criteria: readonly string[] }>;
  /** Milestones by row: those in a row run side by side (milestoneRows). */
  readonly rows: ReadonlyArray<readonly string[]>;
  /** Lines: task → task (waits on), task → gate (finishes the milestone), gate → a milestone that waits on it. */
  readonly edges: ReadonlyArray<{ readonly id: string; readonly from: string; readonly to: string; readonly kind: 'blocks' | 'finish' | 'next' }>;
  /** Changes when (and only when) the layout must: its JSON. */
  readonly key: string;
}

export const gateId = (milestoneId: string): string => `gate:${milestoneId}`;
export const groupId = (milestoneId: string): string => `m:${milestoneId}`;
export const taskNodeId = (taskId: string): string => `t:${taskId}`;

/** The plan graph's structure from what's shown (the draft while there is one). */
export function graphShape(plan: Plan): PlanGraphShape {
  const body = shownBody(plan);
  const milestones = (body?.milestones ?? []).map((m) => ({ id: m.id, tasks: m.tasks.map((t) => t.id), criteria: m.criteria }));
  const edges: Array<PlanGraphShape['edges'][number]> = [];
  for (const m of body?.milestones ?? []) {
    const inside = new Set(m.tasks.map((t) => t.id));
    const needed = new Set(m.tasks.flatMap((t) => t.blockedBy.filter((b) => inside.has(b))));
    for (const t of m.tasks) {
      for (const b of t.blockedBy) edges.push({ id: `${b}->${t.id}`, from: taskNodeId(b), to: taskNodeId(t.id), kind: 'blocks' });
      // The last tasks of a milestone lead to its gate.
      if (!needed.has(t.id)) edges.push({ id: `${t.id}->gate`, from: taskNodeId(t.id), to: gateId(m.id), kind: 'finish' });
    }
  }
  // A milestone's gate opens the milestones that wait on it (only those: the others run alongside),
  // and only the nearest: one that waits on A and on B (which waits on A) gets its line from B alone.
  const deps = new Map((body?.milestones ?? []).map((m) => [m.id, milestoneDeps(body, m)] as const));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
    (deps.get(from) ?? []).some((d) => d === to || (!seen.has(d) && (seen.add(d), reaches(d, to, seen))));
  for (const m of body?.milestones ?? []) {
    const mine = deps.get(m.id) ?? [];
    for (const d of mine) if (!mine.some((o) => o !== d && reaches(o, d))) edges.push({ id: `ms:${d}->${m.id}`, from: gateId(d), to: groupId(m.id), kind: 'next' });
  }
  const rows = milestoneRows(body);
  return { milestones, rows, edges, key: JSON.stringify({ milestones, rows, edges: edges.map((e) => e.id) }) };
}

/** A board task's key, if the plan's task is on the board. */
export function keyOf(board: BoardState, issueId: string | undefined): string | undefined {
  return issueId ? board.issues.find((i) => i.id === issueId)?.key : undefined;
}

export type { MilestoneView };
