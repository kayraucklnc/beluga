import { useState } from 'react';
import type { ProjectEarnings } from '@klaud/core/earnings-store.js';
import type { Project } from '@klaud/workspaces/types.js';
import { stripeKeyKind, stripeKeyProblem } from '@klaud/shared/stripe-keys.js';
import { Alert } from '../components/Alert.js';
import { Field, FormSheet, Popup, TextInput, formStyles as f } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { STRIPE_KEY_URL, closeStripe, formatMoney, missingNote, updatedAgo, useConverted, useProjectEarnings, useStripeSheet } from '../lib/earnings.js';
import { CurrencySelect } from './EarningsSettings.js';
import { brandText } from '../lib/brand.js';
import { useApi, useApp } from '../lib/klaud.js';
import { openExternal } from '../lib/system.js';
import s from './stripe.module.css';

/**
 * Connect Stripe to a project and see what it earned: a key field (masked, paste-aware, live
 * or test said right away), where to make a key that can only read charges, and once
 * connected the account, the totals, Refresh, Replace Key and Disconnect.
 */
export function StripeSheet() {
  const sheet = useStripeSheet();
  if (!sheet) return null;
  return <StripeSheetBody key={sheet.projectId ?? 'pick'} initial={sheet.projectId} />;
}

function StripeSheetBody({ initial }: { initial: string | undefined }) {
  const all = useApp((st) => st.projects);
  const earnings = useApp((st) => st.earnings);
  const projects = all.filter((p) => p.root);
  const [projectId, setProjectId] = useState(() => initial ?? projects.find((p) => !earnings[p.root])?.id ?? projects[0]?.id);
  const [replacing, setReplacing] = useState(false);
  const project = projects.find((p) => p.id === projectId);
  const connected = useProjectEarnings(project?.root);
  if (!project) {
    return <FormSheet title="Connect Stripe" icon="coin" intro="Add a project first: earnings show beside each project in the sidebar." submitLabel="Done" hideSubmit onSubmit={() => undefined} onCancel={closeStripe} />;
  }
  if (connected && !replacing) return <Connected project={project} earnings={connected} onReplace={() => setReplacing(true)} />;
  return <ConnectForm project={project} projects={initial ? undefined : projects} onProject={setProjectId} replacing={Boolean(connected)} onBack={connected ? () => setReplacing(false) : undefined} />;
}

function ConnectForm({ project, projects, onProject, replacing, onBack }: { project: Project; projects: readonly Project[] | undefined; onProject: (id: string) => void; replacing: boolean; onBack: (() => void) | undefined }) {
  const api = useApi();
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [pasted, setPasted] = useState(false);
  const [touched, setTouched] = useState(false);
  const trimmed = key.trim();
  const problem = trimmed ? stripeKeyProblem(trimmed) : undefined;
  const kind = stripeKeyKind(trimmed);
  const showProblem = problem && (touched || pasted);
  return (
    <FormSheet
      title={replacing ? `Replace the Stripe key for ${project.name}` : `Connect Stripe to ${project.name}`}
      icon="coin"
      intro={
        <p>
          See {project.name}’s all-time earnings beside it in the sidebar. Klaud reads your charges once a day; the key stays on this Mac.
        </p>
      }
      submitLabel="Connect"
      canSubmit={Boolean(trimmed) && !problem}
      onCancel={onBack ?? closeStripe}
      cancelLabel={onBack ? 'Back' : 'Cancel'}
      width={560}
      onSubmit={async () => {
        const result = await api.stripe.connect(project.id, trimmed);
        if (!result.ok) return result.error;
        setKey('');
        onBack?.();
        return undefined;
      }}
    >
      {projects && projects.length > 1 ? (
        <Field label="Project" htmlFor="stripe-project">
          <Popup id="stripe-project" label="Project" value={project.id} options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={onProject} />
        </Field>
      ) : null}
      <Field
        label="Restricted key"
        htmlFor="stripe-key"
        error={showProblem ? problem : undefined}
        hint={
          kind.secret && !problem ? (
            <span className={s.caution}>
              <Icon name="alert" size={11} />
              This is a full secret key: it can do anything in your Stripe account. It works, but a restricted key that only reads charges is safer.
            </span>
          ) : pasted && !problem ? (
            'Pasted. Connect checks it with Stripe.'
          ) : (
            'Starts with rk_live_ (or rk_test_ to try it out).'
          )
        }
        aside={
          <>
            {kind.mode && !problem ? <ModeBadge mode={kind.mode} /> : null}
            <button type="button" className={s.reveal} aria-label={reveal ? 'Hide key' : 'Show key'} aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
              <Icon name="eye" size={13} />
            </button>
          </>
        }
      >
        <TextInput
          id="stripe-key"
          type={reveal ? 'text' : 'password'}
          mono
          placeholder="rk_live_…"
          value={key}
          invalid={Boolean(showProblem)}
          onChange={(v) => {
            setKey(v);
            setPasted(false);
          }}
          onBlur={() => setTouched(true)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text').trim();
            if (!text) return;
            e.preventDefault();
            setKey(text);
            setPasted(true);
          }}
          data-autofocus
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
      <div className={s.howto}>
        <div className={s.howtoHead}>
          <span>Don’t have one yet?</span>
          <button type="button" className={f.linkButton} onClick={() => void openExternal(STRIPE_KEY_URL)}>
            Create a restricted key in Stripe
            <Icon name="forward" size={10} />
          </button>
        </div>
        <ol className={s.steps}>
          <li>
            Set <b>Charges</b> to <b>Read</b>: all Klaud needs, refunds included.
          </li>
          <li>
            Optional: under Connect, set <b>Accounts</b> to <b>Read</b> to show the account’s name here.
          </li>
          <li>Create the key, copy it, and paste it above.</li>
        </ol>
        <div className={s.counted}>Counted: every successful charge, what was captured minus refunds, before Stripe’s fees.</div>
      </div>
    </FormSheet>
  );
}

function ModeBadge({ mode }: { mode: 'live' | 'test' }) {
  return <span className={cx(s.badge, mode === 'live' ? s.live : s.testMode)}>{mode === 'live' ? 'Live' : 'Test'}</span>;
}

function Connected({ project, earnings, onReplace }: { project: Project; earnings: ProjectEarnings; onReplace: () => void }) {
  const api = useApi();
  const [confirm, setConfirm] = useState(false);
  const totals = earnings.totals ?? [];
  const money = useConverted(totals);
  const breakdown = money.converted || money.missing.length > 0;
  const note = missingNote(money.missing);
  const needsKey = earnings.error?.code === 'revoked' || earnings.error?.code === 'permission';
  if (confirm) {
    return (
      <Alert
        title={`Disconnect Stripe from ${project.name}?`}
        message="Klaud forgets the key and the totals. Your Stripe account isn’t touched; you can delete the key in Stripe too."
        tone="danger"
        confirm={{
          label: 'Disconnect',
          destructive: true,
          onClick: () => {
            void api.stripe.disconnect(project.id);
            closeStripe();
          },
        }}
        onCancel={() => setConfirm(false)}
      />
    );
  }
  return (
    <FormSheet
      title={`${project.name} earnings`}
      icon="coin"
      intro={
        <span className={s.account}>
          {earnings.account ?? 'Your Stripe account'}
          <ModeBadge mode={earnings.mode} />
        </span>
      }
      submitLabel="Done"
      hideSubmit
      cancelLabel="Done"
      width={480}
      onSubmit={() => undefined}
      onCancel={closeStripe}
      footer={
        <>
          <button type="button" className={f.linkDanger} onClick={() => setConfirm(true)}>
            Disconnect…
          </button>
          <button type="button" className={f.linkButton} onClick={onReplace}>
            Replace Key…
          </button>
        </>
      }
    >
      <div className={cx(s.total, earnings.refreshing && s.counting)} aria-live="polite">
        <span className={s.totalLabel}>All-time earnings</span>
        <span className={s.totalValue}>{earnings.totals ? `${money.converted ? '≈ ' : ''}${formatMoney(money.amount, money.currency)}` : 'Counting…'}</span>
        {breakdown ? (
          <span className={s.others}>
            <span className={s.othersLabel}>In Stripe</span>
            {totals.map((t) => (
              <span key={t.currency}>{formatMoney(t.amount, t.currency)}</span>
            ))}
          </span>
        ) : null}
        {note ? <span className={s.note}>{note}</span> : null}
        <span className={s.meta}>
          {earnings.refreshing ? 'Counting…' : `Updated ${updatedAgo(earnings.updatedAt)}`}
          <button type="button" className={f.linkButton} disabled={earnings.refreshing} onClick={() => void api.stripe.refresh(project.id)}>
            Refresh Now
          </button>
        </span>
      </div>
      <Field label="Currency" htmlFor="stripe-currency" hint="Every project’s earnings show in it, in the sidebar and the Usage view. Also in Settings › General.">
        <CurrencySelect id="stripe-currency" className={f.popup} />
      </Field>
      {earnings.error ? (
        <div className={s.problem} role="status">
          <Icon name="alert" size={13} />
          <span>{brandText(earnings.error.message)}</span>
          {needsKey ? (
            <button type="button" className={f.linkButton} onClick={onReplace}>
              Connect a New Key…
            </button>
          ) : null}
        </div>
      ) : null}
      {earnings.secretKey ? (
        <div className={s.caution}>
          <Icon name="alert" size={11} />
          This is a full secret key. A restricted key that only reads charges is safer: Replace Key… to switch.
        </div>
      ) : null}
      <div className={s.counted}>Successful charges, captured minus refunds, before Stripe’s fees. Klaud refreshes once a day by itself.</div>
    </FormSheet>
  );
}
