import { useState } from 'react';
import type { PullRequest } from '@beluga/core/work-store.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip, cx } from '../components/ui.js';
import { AfterMergeButton, CheckList, MergeButton, ResolveConflictsButton } from '../dialogs/native/PullRequestSheet.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { checksSummary } from '../lib/pr-checks.js';
import { askBeforeWork } from '../lib/work-confirm.js';
import s from './pr-strip.module.css';

const CHECKS: Record<PullRequest['checks'], string> = { passing: 'Checks passed', failing: 'Checks failed', pending: 'Checks running', none: 'No checks' };

/**
 * Above a worktree's conversation, once it has a pull request: where it stands and its one next
 * step. Open: its CI, live (the checks open by themselves while they run or fail), and Merge on
 * GitHub (past the checks too, for an admin), or Resolve Merge Conflicts when GitHub can't merge
 * it. Merged: done, so Archive, or Continue After Merge (a new PR next), or Delete.
 */
export function PrStrip({ workspaceId }: { workspaceId: string }) {
  const actions = useActions();
  const pr = useApp((st) => st.prs[workspaceId]);
  const [open, setOpen] = useState<boolean>();
  const [error, setError] = useState<string>();
  if (!pr || pr.state === 'CLOSED') return null;
  const live = pr.state === 'OPEN';
  const runs = live ? (pr.checkRuns ?? []) : [];
  const shown = runs.length > 0 && (open ?? (pr.checks === 'pending' || pr.checks === 'failing'));
  const tone = pr.checks === 'failing' ? s.bad : pr.checks === 'passing' ? s.ok : pr.checks === 'pending' ? s.wait : undefined;
  return (
    <div className={s.strip} data-pr-strip={pr.state}>
      <div className={s.row}>
        <Tip label="Open the pull request: its checks, review and every way to merge">
          <button type="button" className={s.main} onClick={() => actions.run({ type: 'ws', id: workspaceId, action: 'pr' })}>
            <Icon name={pr.state === 'MERGED' ? 'merge' : 'pr'} size={13} className={pr.state === 'MERGED' ? s.ok : undefined} />
            <span className={s.number}>#{pr.number}</span>
            <span className={s.title}>{pr.title}</span>
          </button>
        </Tip>
        {pr.state === 'MERGED' ? (
          <>
            <span className={cx(s.status, s.ok)}>Merged · done</span>
            <AfterMergeButton wsId={workspaceId} size="small" />
          </>
        ) : (
          <>
            <button type="button" className={cx(s.status, s.toggle, tone)} disabled={!runs.length} aria-expanded={shown} onClick={() => setOpen(!shown)}>
              {pr.checks === 'pending' ? <span className={s.spinner} /> : pr.checks === 'passing' ? <Icon name="check" size={11} /> : pr.checks === 'failing' ? <Icon name="x" size={11} /> : null}
              {runs.length ? checksSummary(runs) : CHECKS[pr.checks]}
              {runs.length ? <Icon name={shown ? 'chevronUp' : 'chevronDown'} size={10} /> : null}
            </button>
            {pr.checks === 'failing' ? (
              <Button size="small" icon="wand" onClick={() => askBeforeWork(workspaceId, 'fix_checks')}>
                Fix Checks…
              </Button>
            ) : null}
            {pr.conflicts ? (
              <>
                <span className={cx(s.status, s.bad)}>Conflicts with the base</span>
                <ResolveConflictsButton wsId={workspaceId} size="small" />
              </>
            ) : (
              <MergeButton wsId={workspaceId} pr={pr} onError={setError} size="small" />
            )}
          </>
        )}
      </div>
      {shown ? <CheckList checks={runs} summary={false} /> : null}
      {error && live ? (
        <div className={s.error} role="alert">
          <Icon name="alert" size={12} />
          {error}
        </div>
      ) : null}
    </div>
  );
}
