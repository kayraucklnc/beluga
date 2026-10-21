import { useMemo } from 'react';
import { planForHome, planTitle, planTaskOfIssue } from '@klaud/core/plans/model.js';
import { issueForWorkspace } from '@klaud/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import { TonePill } from './marks.js';
import { nextWords, planStatus } from './plans-model.js';
import { usePlanActions, usePlanView } from './use-plans.js';
import p from './plans.module.css';

/**
 * Above a conversation that plans (a plan's home): the plan, how it stands and its next step. In a
 * worktree doing a plan's task: which plan and milestone it belongs to.
 */
export function PlanStrip({ workspaceId }: { workspaceId: string }) {
  const home = useApp((s) => planForHome(s.plans, `ws:${workspaceId}`));
  // (Selected as plain values: a new object each time would redraw forever.)
  const issueId = useApp((s) => issueForWorkspace(s.board, workspaceId)?.id);
  const plans = useApp((s) => s.plans);
  const part = useMemo(() => (issueId ? planTaskOfIssue(plans, issueId) : undefined), [plans, issueId]);
  const view = usePlanView(home);
  const { api, act, open } = usePlanActions();
  // An empty draft has nothing to show yet (the box below says what this mode does).
  if (home && view && (home.body || view.milestones.length)) {
    const status = planStatus(view);
    const next = nextWords(view.next);
    const canApprove = (view.next.kind === 'approve' && view.milestones.length > 0) || view.next.kind === 'review_changes';
    return (
      <div className={p.strip}>
        <Tip label="Open the plan">
          <button type="button" className={p.stripMain} onClick={() => open(home.id)}>
            <Icon name="flag" size={12} />
            <span className={p.stripTitle}>{planTitle(home)}</span>
            <TonePill tone={status.tone} live={status.tone === 'claude'}>
              {status.label}
            </TonePill>
            <span className={p.stripNext}>{home.body ? next.title : `${view.milestones.length} milestones · ${view.total} tasks`}</span>
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
  return (
    <div className={p.strip}>
      <button type="button" className={p.stripMain} onClick={() => open(part.plan.id)}>
        <Icon name="flag" size={12} />
        <span className={p.stripTitle}>{planTitle(part.plan)}</span>
        <span className={p.stripNext}>{part.milestone.title}</span>
      </button>
    </div>
  );
}
