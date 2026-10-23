import { tallyWords } from '@beluga/core/board/criteria.js';
import { issueForWorkspace } from '@beluga/core/board/model.js';
import { Icon } from '../components/Icon.js';
import { Tip } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { PrChip, StatusIcon } from './marks.js';
import { checklist } from './tasks-model.js';
import { useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';

/** Above a worktree's conversation: the task it's doing (click to open it), and how far along it is. */
export function TaskStrip({ workspaceId }: { workspaceId: string }) {
  const issue = useApp((s) => issueForWorkspace(s.board, workspaceId));
  const { open } = useTaskActions();
  if (!issue) return null;
  const ticks = checklist(issue.brief.acceptance);
  return (
    <div className={t.strip}>
      <Tip label="Open the task this worktree is doing">
        <button type="button" className={t.stripMain} onClick={() => open(issue)}>
          <StatusIcon status={issue.status} size={13} labelled />
          <span className={t.key}>{issue.key}</span>
          <span className={t.stripTitle}>{issue.title}</span>
          {ticks.total ? (
            <span className={t.stripTicks}>
              <Icon name="check" size={10} />
              {tallyWords(ticks)}
            </span>
          ) : null}
          {issue.needsChecks ? <span className={t.needsChecks}>Needs its checks</span> : null}
        </button>
      </Tip>
      {issue.pr ? <PrChip pr={issue.pr} /> : null}
    </div>
  );
}
