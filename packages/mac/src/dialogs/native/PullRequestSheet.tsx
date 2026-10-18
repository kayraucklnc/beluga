import { useState } from 'react';
import type { PullRequest } from '@klaud/core/work-store.js';
import { findWorkspace } from '@klaud/ui/workspace-models.js';
import { CommandLine, Field, FormSheet, TextArea, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { Button, cx } from '../../components/ui.js';
import { toast, useApi, useApp, useKlaud } from '../../lib/klaud.js';
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

/** The PR you have: its state at a glance, and what to do next. */
function PrCard({ pr, pick, refresh }: { pr: PullRequest; pick: (id: string) => boolean; refresh: () => void }) {
  const checks = CHECKS[pr.checks];
  const review = pr.review ? REVIEW[pr.review] : undefined;
  return (
    <div className={s.pr}>
      <div className={s.prTop}>
        <Icon name="pr" size={15} />
        <span className={s.prNumber}>#{pr.number}</span>
        <span className={cx(s.prTitle, 'selectable')} title={pr.title}>
          {pr.title}
        </span>
        <Button size="small" variant="quiet" icon="refresh" aria-label="Refresh status" onClick={refresh} />
      </div>
      <div className={s.prMeta}>
        <span className={s.pill}>{pr.draft && pr.state === 'OPEN' ? 'Draft' : STATE[pr.state]}</span>
        {pr.state === 'OPEN' ? (
          <span className={cx(s.pill, checks.tone)}>
            {checks.icon ? <Icon name={checks.icon} size={11} /> : null}
            {checks.label}
          </span>
        ) : null}
        {review && pr.state === 'OPEN' ? <span className={cx(s.pill, review.tone)}>{review.label}</span> : null}
      </div>
      <div className={s.prActions}>
        <Button variant="primary" onClick={() => pick('pr-open')}>
          Open on GitHub
        </Button>
        {pr.checks === 'failing' ? (
          <Button icon="claude" onClick={() => pick('pr-fix')}>
            Fix Failing Checks
          </Button>
        ) : null}
        {pr.state === 'OPEN' ? (
          <Button icon="up" onClick={() => pick('pr-update')}>
            Push & Update
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The PR button: create one with Claude (with anything extra to tell it), see the one you have,
 * or, without the GitHub CLI, the two commands that set it up.
 */
export function PullRequestSheet({ menu, close }: NativeMenuProps<'pr'>) {
  const api = useApi();
  const { client } = useKlaud();
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
      <FormSheet title="Connect GitHub" icon="pr" intro="klaud opens pull requests with GitHub’s command-line tool. Set it up once, in Terminal:" submitLabel={checking ? 'Checking…' : 'Check Again'} canSubmit={!checking} onSubmit={check} onCancel={close}>
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
      <FormSheet title={`Pull Request · ${ws.name}`} intro={<>From <code>{ws.branch ?? 'this branch'}</code></>} submitLabel="" hideSubmit onSubmit={() => undefined} onCancel={close} footer={instructions}>
        <PrCard pr={pr} pick={pick} refresh={() => void api.workbench.refreshPrs(menu.id).then(() => toast(client, 'Pull request status refreshed'))} />
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
