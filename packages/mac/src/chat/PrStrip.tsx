import { useState } from 'react';
import type { PullRequest } from '@beluga/core/work-store.js';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { CheckList } from '../dialogs/native/PullRequestSheet.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { checksSummary } from '../lib/pr-checks.js';
import { conversationCounts, openPrPage, usePrConversation } from '../pr/use-pr-conversation.js';
import s from './pr-strip.module.css';

const CHECKS: Record<PullRequest['checks'], string> = { passing: 'Checks passed', failing: 'Checks failed', pending: 'Checks running', none: 'No checks' };

/** How many comments, and how many threads still open: opens the PR's page. */
function CommentsButton({ workspaceId }: { workspaceId: string }) {
  const { data } = usePrConversation(workspaceId);
  const counts = conversationCounts(data);
  if (!data || !counts.said) return null;
  return (
    <Tip label="The PR’s page: what reviewers said, with the code they mean; reply, resolve, or ask your agent">
      <button type="button" className={cx(s.status, s.toggle, counts.open ? s.wait : undefined)} data-pr-comments={counts.said} onClick={() => openPrPage(workspaceId)}>
        <Icon name="chat" size={11} />
        {counts.open ? `${counts.open} open` : `${counts.said} ${counts.said === 1 ? 'comment' : 'comments'}`}
        <Icon name="chevronRight" size={10} />
      </button>
    </Tip>
  );
}

/**
 * Above a worktree's conversation, while its pull request is open: the PR and its CI, live (the
 * checks open by themselves while they run or fail), and how many comments it has (they open
 * its page, BLG-514). Where the
 * branch stands (Merged, Conflicts, Ready to merge) and its steps (Merge, Resolve, Archive…) are
 * at the top, in the toolbar's branch control, so there is one place to see and act on them.
 */
export function PrStrip({ workspaceId }: { workspaceId: string }) {
  const actions = useActions();
  const pr = useApp((st) => st.prs[workspaceId]);
  const [open, setOpen] = useState<boolean>();
  if (!pr || pr.state !== 'OPEN') return null;
  const runs = pr.checkRuns ?? [];
  const shown = runs.length > 0 && (open ?? (pr.checks === 'pending' || pr.checks === 'failing'));
  const tone = pr.checks === 'failing' ? s.bad : pr.checks === 'passing' ? s.ok : pr.checks === 'pending' ? s.wait : undefined;
  return (
    <div className={s.strip} data-pr-strip={pr.state}>
        <div className={s.row}>
          <Tip label="Open the pull request: its checks, review and every way to merge">
            <button type="button" className={s.main} onClick={() => actions.run({ type: 'ws', id: workspaceId, action: 'pr' })}>
              <Icon name="pr" size={13} />
              <span className={s.number}>#{pr.number}</span>
              <span className={s.title}>{pr.title}</span>
            </button>
          </Tip>
          <CommentsButton workspaceId={workspaceId} />
          <button type="button" className={cx(s.status, s.toggle, tone)} disabled={!runs.length} aria-expanded={shown} onClick={() => setOpen(!shown)}>
            {pr.checks === 'pending' ? <span className={s.spinner} /> : pr.checks === 'passing' ? <Icon name="check" size={11} /> : pr.checks === 'failing' ? <Icon name="x" size={11} /> : null}
            {runs.length ? checksSummary(runs) : CHECKS[pr.checks]}
            {runs.length ? <Icon name={shown ? 'chevronUp' : 'chevronDown'} size={10} /> : null}
          </button>
        </div>
        {shown ? <CheckList checks={runs} summary={false} /> : null}
    </div>
  );
}
