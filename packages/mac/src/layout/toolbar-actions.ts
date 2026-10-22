import type { AppState } from '@klaud/core/store.js';
import { type WorkspaceAction, type WorkspaceButton, workspaceButtons } from '@klaud/ui/workspace-models.js';
import type { Workspace } from '@klaud/workspaces/types.js';
import type { IconName } from '../components/Icon.js';
import { COMMAND_KEYS, runRunning } from '../lib/commands.js';
import { mergeTargetOf } from '../lib/merge-review.js';
import { asksBeforeWork } from '../lib/work-confirm.js';

/**
 * A workspace's toolbar, the Mac way: one prominent button for what this workspace needs next
 * (chosen from its state), Run when the project has a run script, and everything else under ⋯,
 * in sections (the git steps, the conversation, the folder, putting it away). The actions are
 * the shared `workspaceButtons` (the terminal app's top bar), so both agree.
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
  /** A workspace action, or `fix_checks` (ask Claude to fix the PR's failing checks). */
  readonly action: WorkspaceAction | 'fix_checks';
}

export interface ToolbarActions {
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
  if (pr?.state === 'OPEN' && pr.checks === 'failing') {
    return { id: 'fix_checks', label: 'Fix Checks…', hint: `PR #${pr.number}'s checks are failing: Claude reads the logs and fixes them`, icon: 'wand', action: 'fix_checks', tone: 'error' };
  }
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
  const merge = by('merge');
  if (merge) {
    const into = mergeTargetOf(state, ws);
    return { ...merge, label: `Merge into ${into}`, hint: `Shows what would merge into ${into} and checks it first; nothing changes until you confirm` };
  }
  const run = all.find((x) => x.action === 'run' || x.action === 'stop_run');
  return run;
}

/** The only icon on the toolbar: Run (or Stop while it runs). The rest are under ⋯. */
const ICONS: readonly WorkspaceAction[] = ['run', 'stop_run'];

/** ⋯'s sections, in order: the git steps, the conversation, the folder, putting it away. */
const SECTIONS: ReadonlyArray<readonly WorkspaceAction[]> = [
  ['run'],
  ['commit', 'pr', 'review_claude', 'merge', 'merge_claude'],
  ['compact', 'handoff', 'share'],
  ['finder', 'fork', 'setup'],
  ['restore', 'archive', 'delete'],
];

export function toolbarActions(state: AppState, ws: Workspace): ToolbarActions {
  const pr = Boolean(state.prs[ws.id]);
  const all = workspaceButtons(state, ws).map((b) => {
    // While the run script runs, its button stops it.
    if (b.action === 'run' && runRunning(state, ws.id)) return { ...toAction(b, pr), id: 'stop_run', action: 'stop_run' as const, label: 'Stop Running', icon: 'stop' as const, hint: 'Stop the run script', keys: KEYS.stop_run };
    return toAction(b, pr);
  });
  const primary = pickPrimary(state, ws, all);
  const shown = (a: ToolAction): boolean => a.action !== primary?.action || primary.id === 'fix_checks';
  const icons = ICONS.flatMap((id) => all.filter((a) => a.action === id && shown(a)));
  const more = inSections(all.filter((a) => !icons.includes(a) && shown(a)));
  return { ...(primary ? { primary } : {}), icons, more };
}

/** Actions in ⋯'s sections, in their order there (any section left empty is dropped). */
export function inSections(list: readonly ToolAction[]): ToolAction[][] {
  const at = (a: ToolAction): number => {
    const i = SECTIONS.findIndex((ids) => ids.includes(a.action === 'stop_run' ? 'run' : (a.action as WorkspaceAction)));
    return i < 0 ? SECTIONS.length : i;
  };
  const rank = (a: ToolAction): number => SECTIONS.flat().indexOf(a.action as WorkspaceAction);
  return Array.from({ length: SECTIONS.length + 1 }, (_, k) => list.filter((a) => at(a) === k).sort((a, b) => rank(a) - rank(b))).filter((section) => section.length > 0);
}
