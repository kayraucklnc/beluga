import { useState } from 'react';
import type { PrCheck, PullRequest } from '@beluga/core/work-store.js';
import type { MergeMethod } from '@beluga/workspaces/pr.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { CommandLine, Field, FormSheet, TextArea, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { ActionsDropdown } from '../../components/SpecMenu.js';
import { Button, Tip, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { MERGE_METHODS, canAutoMerge, checkDuration, checkTone, checksSummary, sortChecks } from '../../lib/pr-checks.js';
import { openExternal } from '../../lib/system.js';
import { useClock } from '../../lib/window-active.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';
import s from './menus.module.css';

const STATE: Record<PullRequest['state'], string> = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' };
const CHECKS: Record<PullRequest['checks'], { label: string; tone?: string; icon?: 'check' | 'x' | 'clock' }> = {
  passing: { label: 'Checks passed', tone: s.pillOk, icon: 'check' },
  failing: { label: 'Checks failed', tone: s.pillBad, icon: 'x' },
  pending: { label: 'Checks running', tone: s.pillWait, icon: 'clock' },
  none: { label: 'No checks' },
};
const REVIEW = { APPROVED: { label: 'Approved', tone: s.pillOk }, CHANGES_REQUESTED: { label: 'Changes requested', tone: s.pillBad }, REVIEW_REQUIRED: { label: 'Waiting for review', tone: undefined } } as const;

/** The way you last merged (squash until you pick another). */
const METHOD_KEY = 'beluga.mergeMethod';
function lastMethod(): MergeMethod {
  try {
    const m = localStorage.getItem(METHOD_KEY);
    return m === 'merge' || m === 'rebase' ? m : 'squash';
  } catch {
    return 'squash';
  }
}

/** Each CI check, live: spinner while it runs, ✓ or ✗ when done, how long, and its page. */
function CheckList({ checks }: { checks: readonly PrCheck[] }) {
  const running = checks.some((c) => c.state === 'in_progress');
  // Running checks count up, only while you're looking (KLD-40).
  const now = useClock(running);
  return (
    <div className={s.checks}>
      <div className={s.checksHead}>{checksSummary(checks)}</div>
      <ul className={s.checkList} aria-label="Checks">
        {sortChecks(checks).map((c, i) => {
          const tone = checkTone(c);
          const time = checkDuration(c, now);
          return (
            <li key={`${c.workflow ?? ''}/${c.name}/${i}`} className={s.checkRow} data-check={tone}>
              <span className={cx(s.checkIcon, s[`check_${tone}`])} aria-label={tone}>
                {tone === 'running' ? <span className={s.spinner} /> : <Icon name={tone === 'passed' ? 'check' : tone === 'failed' ? 'x' : tone === 'queued' ? 'clock' : 'minus'} size={12} />}
              </span>
              <span className={s.checkName} title={c.workflow ? `${c.workflow} / ${c.name}` : c.name}>
                {c.workflow ? <span className={s.checkWorkflow}>{c.workflow} / </span> : null}
                {c.name}
              </span>
              <span className={s.checkTime}>{tone === 'queued' ? 'Queued' : time}</span>
              {c.url ? (
                <button type="button" className={s.checkLink} aria-label={`Open ${c.name} on GitHub`} title="Details on GitHub" onClick={() => void openExternal(c.url!)}>
                  <Icon name="external" size={11} />
                </button>
              ) : (
                <span className={s.checkLink} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Merge on GitHub: the button merges the way you last did (squash at first); its menu picks
 * another way, or "Merge When Checks Pass" while something is still to come.
 */
function MergeButton({ wsId, pr, onError }: { wsId: string; pr: PullRequest; onError: (message: string | undefined) => void }) {
  const api = useApi();
  const [method, setMethod] = useState<MergeMethod>(lastMethod);
  const [busy, setBusy] = useState(false);
  const merge = async (how: MergeMethod, auto = false): Promise<void> => {
    if (busy) return;
    setMethod(how);
    try {
      localStorage.setItem(METHOD_KEY, how);
    } catch {
      // No storage: squash next time.
    }
    setBusy(true);
    onError(undefined);
    try {
      const out = await api.workbench.mergePr(wsId, { method: how, ...(auto ? { auto: true } : {}) });
      if (out && !out.ok) onError(out.message);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const chosen = MERGE_METHODS.find((m) => m.method === method)!;
  const auto = canAutoMerge(pr);
  const items = [
    ...MERGE_METHODS.map((m) => ({ label: m.label, hint: m.hint, checked: m.method === method, onSelect: () => void merge(m.method) })),
    ...(auto ? [{ label: 'Merge When Checks Pass', hint: `${chosen.label} as soon as GitHub allows it`, separate: true, onSelect: () => void merge(method, true) }] : []),
  ];
  return (
    <span className={s.split} role="group" aria-label="Merge on GitHub">
      <Tip label={pr.draft ? 'It’s a draft: mark it ready for review on GitHub first' : `${chosen.label} on GitHub`}>
        <Button variant="merge" icon="merge" className={s.splitMain} disabled={busy || pr.draft} data-merge-github={method} onClick={() => void merge(method)}>
          {busy ? 'Merging…' : 'Merge on GitHub'}
        </Button>
      </Tip>
      <ActionsDropdown items={items} align="start">
        <Button variant="merge" className={s.splitMore} disabled={busy || pr.draft} aria-label="More ways to merge">
          <Icon name="chevronDown" size={11} />
        </Button>
      </ActionsDropdown>
    </span>
  );
}

/** The PR you have: its state and checks at a glance, and what to do next. */
function PrCard({ wsId, pr, pick, refresh }: { wsId: string; pr: PullRequest; pick: (id: string) => boolean; refresh: () => void }) {
  const actions = useActions();
  const [error, setError] = useState<string>();
  const checks = CHECKS[pr.checks];
  const review = pr.review ? REVIEW[pr.review] : undefined;
  const open = pr.state === 'OPEN';
  return (
    <div className={s.pr} data-pr-state={pr.state}>
      <div className={s.prTop}>
        <Icon name={pr.state === 'MERGED' ? 'merge' : 'pr'} size={15} />
        <span className={s.prNumber}>#{pr.number}</span>
        <span className={cx(s.prTitle, 'selectable')} title={pr.title}>
          {pr.title}
        </span>
        <Button size="small" variant="quiet" icon="refresh" aria-label="Refresh status" onClick={refresh} />
      </div>
      <div className={s.prMeta}>
        <span className={cx(s.pill, pr.state === 'MERGED' && s.pillOk)}>
          {pr.state === 'MERGED' ? <Icon name="merge" size={11} /> : null}
          {pr.draft && open ? 'Draft' : STATE[pr.state]}
        </span>
        {open ? (
          <span className={cx(s.pill, checks.tone)}>
            {checks.icon ? <Icon name={checks.icon} size={11} /> : null}
            {checks.label}
          </span>
        ) : null}
        {review && open ? <span className={cx(s.pill, review.tone)}>{review.label}</span> : null}
        {open && pr.conflicts ? <span className={cx(s.pill, s.pillBad)}>Conflicts with the base</span> : null}
        {open && pr.autoMerge ? (
          <span className={cx(s.pill, s.pillWait)}>
            <Icon name="clock" size={11} />
            Merges when checks pass
          </span>
        ) : null}
      </div>
      {pr.checkRuns?.length && pr.state !== 'CLOSED' ? <CheckList checks={pr.checkRuns} /> : null}
      <div className={s.prActions}>
        {open ? <MergeButton wsId={wsId} pr={pr} onError={setError} /> : null}
        {pr.state === 'MERGED' ? (
          <Button variant="primary" icon="archive" data-pr-next="archive" onClick={() => actions.run({ type: 'ws', id: wsId, action: 'archive' })}>
            Archive Worktree
          </Button>
        ) : null}
        <Button onClick={() => pick('pr-open')}>Open on GitHub</Button>
        {pr.checks === 'failing' && open ? (
          <Button icon="claude" onClick={() => pick('pr-fix')}>
            Fix Failing Checks
          </Button>
        ) : null}
        {open ? (
          <Button icon="up" onClick={() => pick('pr-update')}>
            Push & Update
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className={s.prError} role="alert">
          <Icon name="alert" size={12} />
          {error}
        </div>
      ) : null}
      {pr.state === 'MERGED' ? <div className={s.prNote}>Merged on GitHub. Archive the worktree to put it away: its branch and conversation are kept.</div> : null}
    </div>
  );
}

/**
 * The PR button: create one with Claude (with anything extra to tell it), see the one you have,
 * or, without the GitHub CLI, the two commands that set it up.
 */
export function PullRequestSheet({ menu, close }: NativeMenuProps<'pr'>) {
  const api = useApi();
  const { client } = useBeluga();
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const pr = useApp((st) => st.prs[menu.id]);
  const gh = useApp((st) => st.gh);
  const custom = useApp((st) => st.prCustom);
  const [note, setNote] = useState('');
  const [checking, setChecking] = useState(false);
  if (!ws) return null;
  const instructions = (
    <button type="button" className={f.linkButton} onClick={() => pick('pr-edit-prompt')}>
      {custom ? 'Your PR instructions…' : 'PR instructions…'}
    </button>
  );

  if (gh === false) {
    const check = async (): Promise<string | void> => {
      setChecking(true);
      await api.workbench.refreshPrs(menu.id, true);
      setChecking(false);
      if (client.store.getState().gh === false) return 'The GitHub CLI isn’t set up yet. Run both commands in Terminal, then check again.';
      toast(client, 'GitHub is connected', 'success');
    };
    return (
      <FormSheet title="Connect GitHub" icon="pr" intro="Beluga opens pull requests with GitHub’s command-line tool. Set it up once, in Terminal:" submitLabel={checking ? 'Checking…' : 'Check Again'} canSubmit={!checking} onSubmit={check} onCancel={close}>
        <div className={s.ghSteps}>
          <div className={s.ghStep}>
            <div className={s.ghStepTitle}>
              1. Install it <span>· needs Homebrew</span>
            </div>
            <CommandLine command="brew install gh" />
          </div>
          <div className={s.ghStep}>
            <div className={s.ghStepTitle}>
              2. Sign in to GitHub <span>· it opens your browser</span>
            </div>
            <CommandLine command="gh auth login" />
          </div>
        </div>
      </FormSheet>
    );
  }

  if (pr) {
    return (
      <FormSheet width={560} title={`Pull Request · ${ws.name}`} intro={<>From <code>{ws.branch ?? 'this branch'}</code></>} submitLabel="" hideSubmit onSubmit={() => undefined} onCancel={close} footer={instructions}>
        <PrCard wsId={menu.id} pr={pr} pick={pick} refresh={() => void api.workbench.refreshPrs(menu.id).then(() => toast(client, 'Pull request status refreshed'))} />
      </FormSheet>
    );
  }

  return (
    <FormSheet
      title="Create Pull Request"
      icon="pr"
      intro={
        <>
          Claude commits what belongs to the work on <code>{ws.branch ?? 'this branch'}</code>, pushes it and opens a pull request with a short description: what, why, and how to test.
        </>
      }
      submitLabel="Create Pull Request"
      onSubmit={() => {
        // The same as /pr with extra words (or the plain option without them).
        if (note.trim()) void api.workbench.createPr(menu.id, note.trim());
        else pick('pr-create');
        close();
      }}
      onCancel={close}
      footer={instructions}
    >
      <Field label="Instructions" htmlFor="pr-note" hint="Optional: anything extra for this pull request. ⌘Return creates it.">
        <TextArea id="pr-note" value={note} onChange={setNote} rows={3} placeholder="e.g. Open it as a draft and mention issue #42" />
      </Field>
    </FormSheet>
  );
}
