import { type BranchState, branchState, onGitHub } from '@beluga/core/branch-state.js';
import type { AppState } from '@beluga/core/store.js';
import { type PlanOwner, planOwnerOf } from '@beluga/core/plans/owner.js';
import { planTitle } from '@beluga/core/plans/model.js';
import { type WorkspaceAction, type WorkspaceButton, workspaceButtons } from '@beluga/ui/workspace-models.js';
import type { Workspace } from '@beluga/workspaces/types.js';
import type { IconName } from '../components/Icon.js';
import { COMMAND_KEYS, runRunning } from '../lib/commands.js';
import { mergeTargetOf } from '../lib/merge-review.js';
import type { PlanAction } from '../lib/plan-task.js';
import { asksBeforeWork } from '../lib/work-confirm.js';

/**
 * A workspace's toolbar, the Mac way: one prominent button for what this workspace needs next
 * (chosen from its state), Run when the project has a run script, and everything else under ⋯,
 * in sections (the git steps, the conversation, the folder, putting it away). The actions are
 * the shared `workspaceButtons`.
 */
export interface ToolAction {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** The icon button's tooltip, when its name and hint together don't say it well. */
  readonly tip?: string;
  readonly icon: IconName;
  readonly keys?: string;
  readonly disabled?: boolean;
  readonly tone?: 'error' | 'ok' | 'info';
  readonly danger?: boolean;
  /**
   * A workspace action, a pull request's next step (`fix_checks`: Claude fixes its failing checks;
   * `resolve_pr`: Claude resolves its conflicts with the base; `continue_after_merge`: carry on here
   * once it merged), or what a plan's task worktree offers instead of merging (see plan-task.ts).
   */
  readonly action: WorkspaceAction | PrStep | PlanAction;
}

/** A pull request's next steps that ask before Claude or git does them (see work-confirm.ts). */
export type PrStep = 'fix_checks' | 'resolve_pr' | 'continue_after_merge';
export const isPrStep = (a: string): a is PrStep => a === 'fix_checks' || a === 'resolve_pr' || a === 'continue_after_merge';

export interface ToolbarActions {
  /** Where its branch stands, and its steps: when it has any, they lead instead of `primary` (BranchControl). */
  readonly branch?: BranchState;
  readonly primary?: ToolAction;
  /** Icon buttons, in order (some may move under ⋯ when the window is narrow). */
  readonly icons: readonly ToolAction[];
  /** Under ⋯, section by section (a line between sections). */
  readonly more: ReadonlyArray<readonly ToolAction[]>;
}

const ICON: Record<WorkspaceAction, IconName> = {
  run: 'play',
  stop_run: 'stop',
  review_claude: 'review',
  commit: 'commit',
  pr: 'pr',
  merge: 'merge',
  merge_claude: 'merge',
  finder: 'folder',
  fork: 'branch',
  archive: 'archive',
  restore: 'archive',
  delete: 'x',
  handoff: 'hand',
  compact: 'gauge',
  share: 'share',
  setup: 'terminal',
};

const KEYS: Partial<Record<WorkspaceAction, string>> = {
  commit: COMMAND_KEYS['ws-commit'],
  pr: COMMAND_KEYS['ws-pr'],
  merge: COMMAND_KEYS['ws-merge'],
  merge_claude: COMMAND_KEYS['ws-merge'],
  run: COMMAND_KEYS['ws-run'],
  stop_run: COMMAND_KEYS['ws-run'],
  review_claude: COMMAND_KEYS['ws-review'],
  archive: COMMAND_KEYS['ws-archive'],
};

/**
 * Menu-style names for the shared buttons (Finder → Show in Finder, PR → Create Pull Request).
 * The ones that ask first (they start Claude or change git) end in "…", as on the Mac.
 */
function labelOf(b: WorkspaceButton, pr: boolean): string {
  switch (b.action) {
    case 'pr':
      return pr ? b.label : 'Create PR';
    case 'review_claude':
      return 'Ask Claude to Review…';
    case 'commit':
      return 'Commit…';
    case 'merge':
      return 'Merge Locally…';
    case 'compact':
      return 'Compact…';
    case 'finder':
      return 'Show in Finder';
    case 'fork':
      return 'Fork…';
    case 'archive':
      return 'Archive…';
    case 'delete':
      return 'Delete…';
    case 'handoff':
      return 'Hand Off…';
    case 'share':
      return b.label.endsWith('…') ? b.label : `${b.label}…`;
    case 'merge_claude':
      return 'Solve Conflict…';
    default:
      return b.label;
  }
}

/** Tooltips for the icons that ask first: what they'd do, ending in "…" (they ask before doing it). */
function tipOf(b: WorkspaceButton): string | undefined {
  if (b.action === 'review_claude') return 'Ask Claude to review this worktree…';
  return asksBeforeWork(b.action) && !b.disabled ? `${b.hint}…` : undefined;
}

const toAction = (b: WorkspaceButton, pr: boolean): ToolAction => ({
  id: b.action,
  label: labelOf(b, pr),
  hint: b.hint,
  ...(tipOf(b) ? { tip: tipOf(b) } : {}),
  icon: ICON[b.action],
  action: b.action,
  ...(KEYS[b.action] ? { keys: KEYS[b.action] } : {}),
  ...(b.disabled ? { disabled: true } : {}),
  ...(b.tone ? { tone: b.tone } : {}),
  ...(b.action === 'archive' || b.action === 'delete' ? { danger: true } : {}),
});

/** What this workspace needs next, in the order it matters. */
function pickPrimary(state: AppState, ws: Workspace, all: readonly ToolAction[]): ToolAction | undefined {
  const by = (a: WorkspaceAction): ToolAction | undefined => all.find((x) => x.action === a && !x.disabled);
  const pr = state.prs[ws.id];
  if (ws.archived) return by('restore');
  const solve = by('merge_claude');
  if (solve) return { ...solve, tone: 'error' };
  // GitHub can't merge a PR that conflicts with its base: resolving that comes first.
  if (pr?.state === 'OPEN' && pr.conflicts) {
    return { id: 'resolve_pr', label: 'Resolve Merge Conflicts…', hint: `PR #${pr.number} conflicts with ${mergeTargetOf(state, ws)}: Claude merges it in here, resolves the conflicts and pushes`, icon: 'merge', action: 'resolve_pr', tone: 'error' };
  }
  if (pr?.state === 'OPEN' && pr.checks === 'failing') {
    return { id: 'fix_checks', label: 'Fix Checks…', hint: `PR #${pr.number}'s checks are failing: Claude reads the logs and fixes them`, icon: 'wand', action: 'fix_checks', tone: 'error' };
  }
  // On GitHub, a branch's next step is its pull request (Claude commits anything left as it opens it):
  // there its checks run live and it merges into origin. Merge Locally stays under ⋯.
  const create = !pr && onGitHub(state, ws) ? by('pr') : undefined;
  if (create) return { ...create, label: 'Create PR…', hint: `Claude commits what’s left, pushes ${ws.branch ?? 'this branch'} and opens a pull request into ${mergeTargetOf(state, ws)}; its checks show here as they run` };
  const commit = by('commit');
  if (commit) return commit;
  if (pr?.state === 'OPEN') {
    const open = by('pr');
    if (open) return { ...open, label: `PR #${pr.number}` };
  }
  if (pr?.state === 'MERGED') {
    const archive = all.find((x) => x.action === 'archive');
    if (archive) return { ...archive, label: 'Archive Worktree', danger: false, hint: `PR #${pr.number} is merged: put this worktree away (the branch and conversation are kept)` };
  }
  // Part of a plan: Beluga merges it into the plan, so the next thing is the plan, never Merge.
  const plan = all.find((x) => x.action === 'open_plan');
  if (plan) return plan;
  const merge = by('merge');
  if (merge) {
    const into = mergeTargetOf(state, ws);
    return { ...merge, label: `Merge Locally into ${into}`, hint: `Shows what would merge into ${into} on this Mac and checks it first; nothing changes until you confirm` };
  }
  const run = all.find((x) => x.action === 'run' || x.action === 'stop_run');
  return run;
}

/** The only icon on the toolbar: Run (or Stop while it runs). The rest are under ⋯. */
const ICONS: readonly WorkspaceAction[] = ['run', 'stop_run'];

/** ⋯'s sections, in order: the git steps, the conversation, the folder, putting it away. */
const SECTIONS: ReadonlyArray<readonly ToolAction['action'][]> = [
  ['open_plan', 'open_task'],
  ['run'],
  ['commit', 'pr', 'resolve_pr', 'fix_checks', 'review_claude', 'merge', 'merge_anyway', 'merge_claude'],
  ['compact', 'handoff', 'share'],
  ['finder', 'fork', 'setup'],
  ['continue_after_merge', 'restore', 'archive', 'delete'],
];

/** Being made: nothing to do with it yet (its folder isn't there). */
const NONE: ToolbarActions = { icons: [], more: [] };

/** Delete…, beside Archive… (Archive keeps everything; Delete is for what you don't want back). */
const DELETE: ToolAction = { id: 'delete', label: 'Delete…', hint: 'Delete it for good: the folder, its branch and the conversation', icon: ICON.delete, action: 'delete', danger: true };

export function toolbarActions(state: AppState, ws: Workspace): ToolbarActions {
  if (ws.pending) return NONE;
  const pr = Boolean(state.prs[ws.id]);
  const buttons = workspaceButtons(state, ws);
  // Not for worktrees another tool made: those are removed on the Worktrees page (their branch kept).
  const withDelete = !ws.archived && ws.kind !== 'main' && !ws.external && !buttons.some((b) => b.action === 'delete') && !state.prefs.hiddenButtons.includes('delete');
  const own = [...buttons.map((b) => {
    // While the run script runs, its button stops it.
    if (b.action === 'run' && runRunning(state, ws.id)) return { ...toAction(b, pr), id: 'stop_run', action: 'stop_run' as const, label: 'Stop Running', icon: 'stop' as const, hint: 'Stop the run script', keys: KEYS.stop_run };
    return toAction(b, pr);
  }), ...(withDelete ? [ws.kind === 'worktree' ? DELETE : { ...DELETE, hint: 'Remove it from Beluga and delete the conversation' }] : [])];
  const owner = ws.archived ? undefined : planOwnerOf(state.plans, state.board, ws.id);
  const all = owner ? asPlanTask(own, owner, pr) : own;
  const branch = branchState(state, ws, { planned: Boolean(owner) });
  // The branch's own steps lead (Squash and Merge, Resolve with Claude, Continue After Merge…); a plan's task keeps Open Plan.
  const primary = branch?.steps.length ? undefined : pickPrimary(state, ws, all);
  const shown = (a: ToolAction): boolean => a.action !== primary?.action || isPrStep(primary.action);
  const icons = ICONS.flatMap((id) => all.filter((a) => a.action === id && shown(a)));
  // A merged PR: archive it, delete it, or carry on here with a new one.
  const merged = state.prs[ws.id]?.state === 'MERGED' && !ws.archived && !owner;
  const after: ToolAction[] = merged ? [{ id: 'continue_after_merge', label: 'Continue After Merge…', hint: `PR #${state.prs[ws.id]!.number} is done: start this branch again from the latest base and keep the conversation; the next change gets a new PR`, icon: 'branch', action: 'continue_after_merge' }] : [];
  const more = inSections([...all.filter((a) => !icons.includes(a) && shown(a)), ...after]);
  return { ...(branch ? { branch } : {}), ...(primary ? { primary } : {}), icons, more };
}

/** Actions in ⋯'s sections, in their order there (any section left empty is dropped). */
export function inSections(list: readonly ToolAction[]): ToolAction[][] {
  const at = (a: ToolAction): number => {
    const i = SECTIONS.findIndex((ids) => ids.includes(a.action === 'stop_run' ? 'run' : a.action));
    return i < 0 ? SECTIONS.length : i;
  };
  const rank = (a: ToolAction): number => SECTIONS.flat().indexOf(a.action);
  return Array.from({ length: SECTIONS.length + 1 }, (_, k) => list.filter((a) => at(a) === k).sort((a, b) => rank(a) - rank(b))).filter((section) => section.length > 0);
}

/**
 * A worktree doing a plan's task is part of the plan: Open Plan and Open Task lead, and Merge
 * becomes 'Merge Anyway…' (Beluga merges it into the plan when its milestone passes). No PR of its
 * own either: the plan opens one PR at the end (one already open stays reachable).
 */
function asPlanTask(all: readonly ToolAction[], owner: PlanOwner, pr: boolean): ToolAction[] {
  const name = planTitle(owner.plan);
  const lead: ToolAction[] = [
    { id: 'open_plan', label: 'Open Plan', hint: `Part of “${name}”: Beluga merges it into the plan when “${owner.milestone.title}” passes`, icon: 'flag', action: 'open_plan' },
    { id: 'open_task', label: 'Open Task', hint: `The task this worktree does (${owner.issue.key})`, icon: 'task', action: 'open_task' },
  ];
  const rest = all.flatMap((a): ToolAction[] => {
    if (a.action === 'pr' && !pr) return [];
    // Solving a conflict finishes a local merge: it stays, but says so and warns first (actions.run).
    if (a.action === 'merge_claude') return [{ ...a, hint: `Claude finishes this merge by hand, which skips “${name}”: Beluga merges it into the plan itself` }];
    if (a.action !== 'merge') return [a];
    return [{ ...a, id: 'merge_anyway', label: 'Merge Anyway…', action: 'merge_anyway', hint: `Beluga merges this into “${name}” itself; merging it by hand skips the plan` }];
  });
  return [...lead, ...rest];
}
