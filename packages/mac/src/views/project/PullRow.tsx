import { memo, useEffect, useRef, useState } from 'react';
import type { GhPull, PullsList } from '@beluga/core/issues/model.js';
import { Icon } from '../../components/Icon.js';
import { type ActionItem, ActionsContext, ActionsDropdown } from '../../components/SpecMenu.js';
import { IconButton, Tip, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { copyText } from '../../lib/copy.js';
import { keepSeen, lastSeen } from '../../lib/last-seen.js';
import { TonePill } from '../../plans/marks.js';
import type { Tone } from '../../plans/plans-model.js';
import { ago } from '../../tasks/tasks-model.js';
import { agoWords } from '../../issues/issues-model.js';
import s from '../../issues/issues.module.css';

/** A project's open pull requests on GitHub (anyone's), for its home: read through the core, kept a little while. */

const lists = new Map<string, { readonly job: Promise<PullsList>; readonly at: number }>();
const UI_TTL_MS = 30_000;

/** A project's open pull requests; what was read last time shows at once while it's read again. */
export function usePullList(projectId: string): PullsList | undefined {
  const api = useApi();
  const [got, setGot] = useState<{ readonly id: string; readonly list: PullsList }>();
  const current = useRef(projectId);
  current.current = projectId;
  useEffect(() => {
    const kept = lists.get(projectId);
    const fresh = kept && Date.now() - kept.at < UI_TTL_MS;
    const job = fresh ? kept.job : api.issues.pulls(projectId);
    if (!fresh) lists.set(projectId, { job, at: Date.now() });
    job.then(
      (list) => {
        keepSeen(`pulls:${projectId}`, list);
        if (current.current === projectId) setGot({ id: projectId, list });
      },
      () => lists.delete(projectId),
    );
  }, [projectId]);
  return got?.id === projectId ? got.list : lastSeen<PullsList>(`pulls:${projectId}`);
}

const CHECKS: Record<Exclude<GhPull['checks'], 'none'>, { readonly label: string; readonly tone: Tone }> = {
  passing: { label: 'Checks pass', tone: 'ok' },
  failing: { label: 'Checks fail', tone: 'error' },
  pending: { label: 'Checks running', tone: 'claude' },
};

const REVIEW: Record<NonNullable<GhPull['review']>, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Review required',
};

/**
 * One open pull request: its title, number, author and branch, Draft, review and checks, when.
 * One on a branch of the project's worktrees opens that worktree; any other opens on GitHub.
 */
export const PullRow = memo(function PullRow({ projectId, pull }: { projectId: string; pull: GhPull }) {
  const actions = useActions();
  const { client } = useBeluga();
  const ws = useApp((st) => st.projects.find((p) => p.id === projectId)?.workspaces.find((w) => w.kind === 'worktree' && !w.archived && w.branch === pull.branch)?.id);
  const onGitHub = (): void => actions.openLink({ kind: 'url', url: pull.url });
  const open = (): void => (ws ? actions.run({ type: 'open_ws', id: ws }) : onGitHub());
  const menu = (): ActionItem[] => [
    ...(ws ? [{ label: 'Open the Worktree', icon: 'branch' as const, onSelect: open }] : []),
    { label: 'Open on GitHub', icon: 'external', separate: Boolean(ws), onSelect: onGitHub },
    { label: 'Copy Link', icon: 'copy', onSelect: () => void copyText(pull.url).then(() => toast(client, `Copied the link to #${pull.number}`, 'success')) },
  ];
  const checks = pull.checks === 'none' ? undefined : CHECKS[pull.checks];
  return (
    <ActionsContext items={menu}>
      <div
        role="listitem"
        tabIndex={0}
        className={cx(s.row, s.rowCompact)}
        onClick={open}
        onKeyDown={(e) => e.key === 'Enter' && open()}
        aria-label={`#${pull.number} ${pull.title}${pull.draft ? ', draft' : ''}${ws ? ', in a worktree' : ''}`}
        data-pull={pull.number}
      >
        <span className={cx(s.state, !pull.draft && s.state_open)} role="img" aria-label={pull.draft ? 'Draft' : 'Open'}>
          <Icon name="pr" size={15} />
        </span>
        <span className={s.rowMain}>
          <span className={s.rowTop}>
            <span className={s.rowTitle}>{pull.title}</span>
          </span>
          <span className={s.rowSub}>
            #{pull.number} · {pull.author ? `${pull.author} · ` : ''}
            {pull.branch ? `${pull.branch} · ` : ''}opened {agoWords(pull.createdAt)}
          </span>
        </span>
        {ws ? (
          <Tip label="You have a worktree on this branch: a click opens it">
            <span className={s.comments}>
              <Icon name="branch" size={12} />
            </span>
          </Tip>
        ) : null}
        {pull.draft ? <TonePill tone="muted">Draft</TonePill> : pull.review ? <TonePill tone={pull.review === 'APPROVED' ? 'ok' : pull.review === 'CHANGES_REQUESTED' ? 'warn' : 'neutral'}>{REVIEW[pull.review]}</TonePill> : null}
        {checks ? (
          <TonePill tone={checks.tone} live={pull.checks === 'pending'}>
            {checks.label}
          </TonePill>
        ) : null}
        <span className={s.when}>{ago(pull.updatedAt)}</span>
        <span className={s.rowMore} onClick={(e) => e.stopPropagation()}>
          <ActionsDropdown items={menu()}>
            <IconButton icon="more" label={`What to do with #${pull.number}`} />
          </ActionsDropdown>
        </span>
      </div>
    </ActionsContext>
  );
});
