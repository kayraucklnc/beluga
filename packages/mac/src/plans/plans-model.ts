import type { BoardState } from '../../../../src/core/board/model.js';
import { type Plan, type PlansState, diffBodies, planTitle, shownBody } from '../../../../src/core/plans/model.js';
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
  planned: { label: 'In plan', tone: 'info' },
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
    case 'start':
      return { title: next.tasks.length === 1 ? `Start “${next.tasks[0]!.task.title}”` : `Start ${next.tasks.length} Tasks`, detail: next.tasks.length === 1 ? 'Ready to go' : 'Ready to go, side by side' };
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
      if (next.pr?.state === 'CLOSED') return { title: `Pull request #${next.pr.number} was closed`, detail: 'Closed without merging: the plan’s tasks stay In Plan' };
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
  /** Milestones as boxes (in order), each with its tasks and a gate at its end. */
  readonly milestones: ReadonlyArray<{ readonly id: string; readonly tasks: readonly string[] }>;
  /** Lines: task → task (waits on), task → gate (finishes the milestone), gate → the next milestone. */
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
  const milestones = (body?.milestones ?? []).map((m) => ({ id: m.id, tasks: m.tasks.map((t) => t.id) }));
  const edges: Array<PlanGraphShape['edges'][number]> = [];
  for (const [i, m] of (body?.milestones ?? []).entries()) {
    const inside = new Set(m.tasks.map((t) => t.id));
    const needed = new Set(m.tasks.flatMap((t) => t.blockedBy.filter((b) => inside.has(b))));
    for (const t of m.tasks) {
      for (const b of t.blockedBy) edges.push({ id: `${b}->${t.id}`, from: taskNodeId(b), to: taskNodeId(t.id), kind: 'blocks' });
      // The last tasks of a milestone lead to its gate.
      if (!needed.has(t.id)) edges.push({ id: `${t.id}->gate`, from: taskNodeId(t.id), to: gateId(m.id), kind: 'finish' });
    }
    const next = body!.milestones[i + 1];
    // The gate opens the next milestone.
    if (next) edges.push({ id: `${m.id}->${next.id}`, from: gateId(m.id), to: groupId(next.id), kind: 'next' });
  }
  return { milestones, edges, key: JSON.stringify({ milestones, edges: edges.map((e) => e.id) }) };
}

/** A board task's key, if the plan's task is on the board. */
export function keyOf(board: BoardState, issueId: string | undefined): string | undefined {
  return issueId ? board.issues.find((i) => i.id === issueId)?.key : undefined;
}

export type { MilestoneView };
