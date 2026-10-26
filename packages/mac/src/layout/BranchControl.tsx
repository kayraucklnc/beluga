import { useState } from 'react';
import type { BranchState, BranchStep, BranchTone } from '@beluga/core/branch-state.js';
import type { MergeMethod } from '@beluga/workspaces/pr.js';
import { lastMethod, rememberMethod } from '../dialogs/native/PullRequestSheet.js';
import { Icon, type IconName } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi } from '../lib/beluga.js';
import { MERGE_METHODS } from '../lib/pr-checks.js';
import { askBeforeWork } from '../lib/work-confirm.js';
import { useWsBusy, whileBusy } from '../lib/ws-busy.js';
import s from './BranchControl.module.css';

const PILL_ICON: Record<BranchTone, IconName> = { merged: 'merge', ok: 'check', error: 'alert', warn: 'alert', wait: 'clock', info: 'branch', muted: 'branch' };

export type BranchFold = 'none' | 'pill' | 'all';

const STEP_ICON: Partial<Record<BranchStep['id'], IconName>> = { merge_pr: 'merge', merge: 'merge', merge_auto: 'clock', cancel_auto: 'x', update_branch: 'refresh', mark_ready: 'check', open_pr: 'pr', continue_after_merge: 'branch', archive: 'archive', delete: 'x', commit: 'commit', pr: 'pr', pr_draft: 'pr' };

const STEP_SHORT: Partial<Record<BranchStep['id'], string>> = { pr: 'PR', open_pr: 'PR', pr_draft: 'Draft', pr_claude: 'PR', pr_custom: 'PR', merge_pr: 'Merge', merge: 'Merge', merge_auto: 'Auto-merge', merge_admin: 'Merge', cancel_auto: 'Cancel', update_branch: 'Update', mark_ready: 'Ready', review_claude: 'Review', fix_checks: 'Fix', resolve_pr: 'Resolve', merge_claude: 'Resolve' };

/** A step in one word, for the folded toolbar: the icon alone didn't say enough. */
export const shortLabel = (step: BranchStep): string => STEP_SHORT[step.id] ?? step.label.replace(/…$/, '').split(' ')[0]!;

/**
 * The top of a worktree: where its branch stands, as a pill you can read from across the room
 * (Merged in purple, Ready to merge in green, Conflicts in red…), and the step it needs next as
 * one button (its pull request's number on the pill too). Its chevron has the other steps: one-click ones (git or GitHub does them) and the
 * ones Claude does, marked with Claude's icon. The pill opens the pull request when there is one.
 * In a narrow toolbar it folds: `pill` keeps the pill's icon and number, `all` the step's icon and
 * one short word ("PR", "Merge"), the full words moving to their tips.
 */
export function BranchControl({ wsId, branch, fold = 'none' }: { wsId: string; branch: BranchState; fold?: BranchFold }) {
  const api = useApi();
  const actions = useActions();
  const [method, setMethod] = useState<MergeMethod>(lastMethod);
  // This worktree's, not the component's: it's the same one when you switch to another worktree.
  const busy = useWsBusy(wsId);
  const [main, ...rest] = branch.steps;

  const merge = (how: MergeMethod, mode?: 'auto' | 'admin'): void => {
    setMethod(how);
    rememberMethod(how);
    // Workbench says how it went (a toast), and GitHub's new state shows here.
    void whileBusy(wsId, () => api.workbench.mergePr(wsId, { method: how, ...(mode ? { [mode]: true } : {}) }));
  };
  const run = (step: BranchStep): void => {
    if (busy) return;
    switch (step.id) {
      case 'merge_pr':
        return merge(method);
      case 'merge_auto':
        return merge(method, 'auto');
      case 'merge_admin':
        return merge(method, 'admin');
      case 'cancel_auto':
        return void whileBusy(wsId, () => api.workbench.cancelMergeWhenReady(wsId));
      case 'update_branch':
      case 'mark_ready':
        return void whileBusy(wsId, () => api.workbench.prStep(wsId, step.id === 'mark_ready' ? 'ready' : 'update_branch'));
      case 'resolve_pr':
      case 'fix_checks':
      case 'continue_after_merge':
        return askBeforeWork(wsId, step.id);
      case 'open_pr':
      case 'pr_custom':
        return actions.run({ type: 'ws', id: wsId, action: 'pr' });
      case 'pr':
      case 'pr_draft':
        // Straight to GitHub, no Claude in between (Workbench toasts how it went).
        return void whileBusy(wsId, () => api.workbench.quickPr(wsId, step.id === 'pr_draft' ? { draft: true } : {}));
      case 'pr_claude':
        return void api.workbench.createPr(wsId);
      default:
        return actions.run({ type: 'ws', id: wsId, action: step.id });
    }
  };
  const iconOf = (step: BranchStep): IconName => (step.claude ? 'claude' : (STEP_ICON[step.id] ?? 'branch'));
  const labelOf = (step: BranchStep): string => (step.id === 'merge_pr' ? (MERGE_METHODS.find((m) => m.method === method)?.label ?? step.label) : step.label);

  // Squash, merge commit or rebase: picking one merges that way (and is remembered).
  const methods: ActionItem[] = main?.id === 'merge_pr' ? MERGE_METHODS.map((m) => ({ label: m.label, hint: m.hint, checked: m.method === method, onSelect: () => void merge(m.method) })) : [];
  const items: ActionItem[] = [
    ...methods,
    ...rest.map((step, i) => ({ label: labelOf(step), hint: step.claude ? `Claude · ${step.hint}` : step.hint, icon: iconOf(step), ...(step.danger ? { danger: true } : {}), separate: i === 0 && methods.length > 0, onSelect: () => requestAnimationFrame(() => run(step)) })),
  ];
  const variant = main && (main.id === 'merge_pr' || main.id === 'merge') ? 'merge' : 'primary';
  const pill = (
    <span className={cx(s.pill, s[`pill_${branch.tone}`])} data-branch-state={branch.kind}>
      <Icon name={PILL_ICON[branch.tone]} size={11} />
      {fold === 'none' ? branch.label : null}
      {branch.pr ? <span className={s.pillPr}>#{branch.pr.number}</span> : null}
    </span>
  );

  return (
    <span className={s.wrap} role="group" aria-label={`Branch: ${branch.label}`}>
      <Tip label={`${fold === 'none' ? '' : `${branch.label}: `}${branch.detail}${branch.pr ? ' · open the pull request' : ''}`}>
        {branch.pr ? (
          <button type="button" className={s.pillButton} onClick={() => actions.run({ type: 'ws', id: wsId, action: 'pr' })}>
            {pill}
          </button>
        ) : (
          pill
        )}
      </Tip>
      {main ? (
        <span className={s.split}>
          <Tip label={`${fold === 'all' ? `${labelOf(main)}: ` : ''}${main.claude ? `Claude · ${main.hint}` : main.hint}`}>
            <Button variant={variant} icon={iconOf(main)} aria-label={fold === 'all' ? labelOf(main) : undefined} className={cx(s.main, items.length > 0 && s.mainSplit, branch.tone === 'error' && s.mainError, branch.tone === 'merged' && s.mainMerged)} disabled={busy} data-branch-step={main.id} data-tool-ws={wsId} onClick={() => run(main)}>
              {busy ? (fold === 'all' ? '…' : 'Working…') : fold === 'all' ? shortLabel(main) : labelOf(main)}
            </Button>
          </Tip>
          {items.length ? (
            <ActionsDropdown items={items} align="end">
              <Button variant={variant} className={cx(s.more, branch.tone === 'error' && s.mainError, branch.tone === 'merged' && s.mainMerged)} disabled={busy} aria-label="Other steps for this branch" data-branch-more={wsId}>
                <Icon name="chevronDown" size={11} />
              </Button>
            </ActionsDropdown>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
