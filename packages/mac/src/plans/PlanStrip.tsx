import { useMemo } from 'react';
import { planForHome, planTitle, planTaskOfIssue } from '@beluga/core/plans/model.js';
import { issueForWorkspace } from '@beluga/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { Said } from './marks.js';
import { headline, taskHeadline } from './plans-model.js';
import { usePlanActions, usePlanView } from './use-plans.js';
import p from './plans.module.css';

/**
 * Above a conversation that plans (a plan's home): the plan and its one sentence (who it waits
 * for). In a worktree doing a plan's task: which plan, and the same sentence from the task's side
 * (“Done. Claude is checking “API”; Beluga merges this into the plan”).
 */
export function PlanStrip({ workspaceId }: { workspaceId: string }) {
  const home = useApp((s) => planForHome(s.plans, `ws:${workspaceId}`));
  // (Selected as plain values: a new object each time would redraw forever.)
  const issueId = useApp((s) => issueForWorkspace(s.board, workspaceId)?.id);
  const plans = useApp((s) => s.plans);
  const part = useMemo(() => (issueId && !home ? planTaskOfIssue(plans, issueId) : undefined), [plans, issueId, home]);
  const view = usePlanView(home ?? part?.plan);
  const { api, act, open } = usePlanActions();
  // An empty draft has nothing to show yet (the box below says what this mode does).
  if (home && view && (home.body || view.milestones.length)) {
    const canApprove = (view.next.kind === 'approve' && view.milestones.length > 0) || view.next.kind === 'review_changes';
    return (
      <div className={p.strip}>
        <Tip label="Open the plan">
          <button type="button" className={p.stripMain} onClick={() => open(home.id)}>
            <Icon name="flag" size={12} />
            <span className={p.stripTitle}>{planTitle(home)}</span>
            <Said line={headline(view)} className={p.stripNext} />
          </button>
        </Tip>
        {canApprove ? (
          <Button size="small" variant="primary" onClick={() => void act(() => api.approve(home.id), home.body ? 'Changes applied' : 'Plan approved: its tasks are on the board')}>
            {home.body ? 'Apply Changes' : 'Approve Plan'}
          </Button>
        ) : null}
      </div>
    );
  }
  if (!part || home) return null;
  const line = view ? taskHeadline(view, part.task.id) : undefined;
  return (
    <div className={p.strip}>
      <Tip label="Open the plan">
        <button type="button" className={p.stripMain} onClick={() => open(part.plan.id)}>
          <Icon name="flag" size={12} />
          <span className={p.stripTitle}>{planTitle(part.plan)}</span>
          <span className={p.stripMilestone}>{part.milestone.title}</span>
          {line ? <Said line={line} className={p.stripNext} /> : null}
        </button>
      </Tip>
    </div>
  );
}
