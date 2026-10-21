import type { Actor, Priority } from '../board/model.js';

/**
 * Plans: a goal cut into milestones, each with tasks and the criteria that say it's passed.
 * Claude writes a plan in a conversation (its home); until you approve it, the plan is only a
 * draft there and never touches Tasks. Approving puts its tasks on the board, and the plan then
 * runs milestone by milestone, as far on its own as its autonomy allows.
 * Browser-safe: the Mac app runs it. See docs/tasks-and-plans.md.
 */

export const AUTONOMIES = ['step', 'gated', 'autopilot'] as const;
export type Autonomy = (typeof AUTONOMIES)[number];

export const AUTONOMY_INFO: Readonly<Record<Autonomy, { readonly label: string; readonly hint: string }>> = {
  step: { label: 'Step by Step', hint: 'Claude lines up what can start; you start each task' },
  gated: { label: 'Gated', hint: 'Tasks start by themselves; each milestone waits for you to pass it' },
  autopilot: { label: 'Autopilot', hint: 'Milestone to milestone on its own: Claude checks each one; it stops only when something fails' },
};

/** One task of a plan, before and after it's on the board. */
export interface PlanTask {
  /** Stable inside the plan ("auth-api"): Claude names tasks by it, and it survives re-planning. */
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  readonly context?: string;
  /** Done means all of these are true. */
  readonly acceptance: readonly string[];
  /** Tasks of this plan that must be finished first (ids). */
  readonly blockedBy: readonly string[];
  /** A sub-task's parent (an id in the same milestone). */
  readonly parent?: string;
  readonly priority?: Priority;
  readonly estimate?: number;
  readonly labels?: readonly string[];
  /** Files or areas it changes: tasks that run side by side shouldn't share them. */
  readonly touches?: readonly string[];
  /** Who works on it: your Claude (the default) or you. */
  readonly assignee?: 'claude' | 'me';
  /** Its task on the board, once the plan is approved. */
  readonly issueId?: string;
}

export interface PlanMilestone {
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  /** Pass criteria: what must be true to call the milestone done (checked by Claude, passed by you or Claude). */
  readonly criteria: readonly string[];
  readonly tasks: readonly PlanTask[];
  /** This milestone's own autonomy (else the plan's). */
  readonly autonomy?: Autonomy;
}

/** What a plan says: the part Claude writes and you approve. */
export interface PlanBody {
  readonly title: string;
  readonly goal: string;
  readonly milestones: readonly PlanMilestone[];
}

/** Claude's check of a milestone's pass criteria. */
export interface GateCheck {
  readonly at: number;
  readonly by: Actor;
  readonly verdict: 'pass' | 'fail';
  readonly notes: string;
}

/** How a milestone is going (by milestone id). */
export interface MilestoneRun {
  readonly passedAt?: number;
  readonly passedBy?: Actor;
  /** Claude's latest check of its criteria. */
  readonly check?: GateCheck;
  /** When the head Claude was asked to check it (asked once per round). */
  readonly checkAsked?: number;
}

export type PlanEventKind = 'created' | 'drafted' | 'approved' | 'changed' | 'started' | 'gate' | 'passed' | 'failed' | 'autonomy' | 'paused' | 'resumed' | 'done' | 'note' | 'problem';

export interface PlanEvent {
  readonly id: string;
  readonly at: number;
  readonly by: Actor;
  readonly kind: PlanEventKind;
  readonly text: string;
}

export type PlanStatus = 'draft' | 'active' | 'done';

export interface Plan {
  readonly id: string;
  readonly projectId: string;
  /** The conversation it's planned and run from (`ws:<id>`): its head Claude. */
  readonly home: string;
  readonly status: PlanStatus;
  /** What was approved (its tasks are on the board). */
  readonly body?: PlanBody;
  /** Claude's (and your) working copy, not on the board: a new plan, or changes to an approved one. */
  readonly draft?: PlanBody;
  /** Bumped by every change to the draft (screens and Claude see it moved). */
  readonly draftRev: number;
  readonly autonomy: Autonomy;
  /** How many of its tasks may run at once. */
  readonly maxParallel: number;
  readonly paused: boolean;
  readonly runs: Readonly<Record<string, MilestoneRun>>;
  readonly activity: readonly PlanEvent[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvedAt?: number;
  readonly doneAt?: number;
}

export interface PlansState {
  /** Plans run (the Mac app's daemon); off elsewhere. */
  readonly enabled: boolean;
  readonly plans: readonly Plan[];
  /** Your planning style: how you like plans cut (added to Claude's planning instructions). */
  readonly style: string;
}

export interface PlansSlice {
  readonly plans: PlansState;
}

export const KEEP_PLAN_ACTIVITY = 200;
export const MAX_MILESTONES = 12;
export const MAX_PLAN_TASKS = 80;
export const DEFAULT_PARALLEL = 3;
export const MAX_PARALLEL = 8;

export const NO_PLANS: PlansState = { enabled: false, plans: [], style: '' };
export const initialPlans: PlansSlice = { plans: NO_PLANS };

export type PlansAction =
  | { type: 'plans_init'; state: PlansState }
  | { type: 'plan_put'; plan: Plan }
  | { type: 'plan_remove'; id: string }
  | { type: 'plans_style'; style: string }
  | { type: 'plans_off' };

export const PLANS_ACTIONS: ReadonlySet<string> = new Set(['plans_init', 'plan_put', 'plan_remove', 'plans_style', 'plans_off']);

export function reducePlans(state: PlansSlice, action: PlansAction): PlansSlice {
  switch (action.type) {
    case 'plans_init':
      return { plans: action.state };
    case 'plan_put': {
      const list = state.plans.plans;
      const at = list.findIndex((p) => p.id === action.plan.id);
      return { plans: { ...state.plans, plans: at >= 0 ? list.map((p, n) => (n === at ? action.plan : p)) : [...list, action.plan] } };
    }
    case 'plan_remove':
      return { plans: { ...state.plans, plans: state.plans.plans.filter((p) => p.id !== action.id) } };
    case 'plans_style':
      return { plans: { ...state.plans, style: action.style } };
    case 'plans_off':
      return { plans: NO_PLANS };
    default:
      return state;
  }
}

// ---- for screens and Claude

export const planById = (state: PlansState, id: string): Plan | undefined => state.plans.find((p) => p.id === id);

/** The plan a conversation is the home of (the newest, when several were). */
export const planForHome = (state: PlansState, channel: string): Plan | undefined => [...state.plans].reverse().find((p) => p.home === channel);

/** What a screen shows of a plan: the draft while there is one, else what was approved. */
export const shownBody = (plan: Plan): PlanBody | undefined => plan.draft ?? plan.body;

export const planTitle = (plan: Plan): string => shownBody(plan)?.title || 'New plan';

/** Every task of a body, with the milestone it's in. */
export function allTasks(body: PlanBody | undefined): Array<{ readonly task: PlanTask; readonly milestone: PlanMilestone; readonly index: number }> {
  return (body?.milestones ?? []).flatMap((milestone, index) => milestone.tasks.map((task) => ({ task, milestone, index })));
}

export const taskById = (body: PlanBody | undefined, id: string): PlanTask | undefined => allTasks(body).find((t) => t.task.id === id)?.task;

/** The plan task a board task came from. */
export function planTaskOfIssue(state: PlansState, issueId: string): { readonly plan: Plan; readonly task: PlanTask; readonly milestone: PlanMilestone } | undefined {
  for (const plan of state.plans) {
    const hit = allTasks(plan.body).find((t) => t.task.issueId === issueId);
    if (hit) return { plan, task: hit.task, milestone: hit.milestone };
  }
  return undefined;
}

/** A milestone's own autonomy, else its plan's. */
export const autonomyOf = (plan: Plan, milestone: PlanMilestone | undefined): Autonomy => milestone?.autonomy ?? plan.autonomy;

/** How a draft differs from what was approved: tasks added, changed and removed (by id). */
export interface PlanDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly milestones: number;
}

export function diffBodies(before: PlanBody | undefined, after: PlanBody | undefined): PlanDiff {
  const old = new Map(allTasks(before).map((t) => [t.task.id, t]));
  const now = new Map(allTasks(after).map((t) => [t.task.id, t]));
  const added = [...now.keys()].filter((id) => !old.has(id));
  const removed = [...old.keys()].filter((id) => !now.has(id));
  const changed = [...now.keys()].filter((id) => {
    const a = old.get(id);
    const b = now.get(id)!;
    return a && (a.milestone.id !== b.milestone.id || taskSignature(a.task) !== taskSignature(b.task));
  });
  const ms = (b: PlanBody | undefined): string => (b?.milestones ?? []).map((m) => `${m.id}\0${m.title}\0${m.goal ?? ''}\0${m.criteria.join('\0')}`).join('\n');
  const milestones = ms(before) === ms(after) ? 0 : Math.max(1, Math.abs((after?.milestones.length ?? 0) - (before?.milestones.length ?? 0)));
  return { added, changed, removed, milestones };
}

/** What makes a task different, without what the board gave it. */
export function taskSignature(t: PlanTask): string {
  const { issueId: _i, ...rest } = t;
  return JSON.stringify(rest);
}

export const isEmptyDiff = (d: PlanDiff): boolean => !d.added.length && !d.changed.length && !d.removed.length && !d.milestones;
