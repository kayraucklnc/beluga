import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, IconButton, Tip, cx } from '../components/ui.js';
import { EarningsTipBody } from '../components/EarningsPill.js';
import { dismissEarningsHint, formatMoney, openStripe, updatedAgo, useEarnings, useEarningsHintDismissed } from '../lib/earnings.js';
import { useApi, useApp } from '../lib/klaud.js';
import s from './earnings-card.module.css';

/**
 * The Overview's Earnings: every project with Stripe connected and what it earned, all-time.
 * Before any is connected, a one-time hint says it exists (dismissed for good with ✕).
 */
export function EarningsCard() {
  const api = useApi();
  const summary = useEarnings();
  const dismissed = useEarningsHintDismissed();
  const repos = useApp((st) => st.projects.filter((p) => p.root).length);
  if (!summary.projects.length) {
    if (dismissed || !repos) return null;
    return (
      <section className={s.hint} aria-label="Track earnings">
        <span className={s.hintIcon} aria-hidden="true">
          <Icon name="coin" size={16} />
        </span>
        <span className={s.hintText}>
          <span className={s.hintTitle}>Track what your projects earn</span>
          <span className={s.hintDetail}>Connect Stripe to a project and its all-time earnings show beside it in the sidebar, refreshed once a day.</span>
        </span>
        <Button size="small" variant="primary" onClick={() => openStripe()}>
          Connect Stripe…
        </Button>
        <IconButton icon="x" label="Don’t show this again" className={s.dismiss} onClick={dismissEarningsHint} />
      </section>
    );
  }
  const [main, ...more] = summary.totals;
  return (
    <section className={s.card} aria-label="Earnings">
      <div className={s.head}>
        <h2 className={s.title}>Earnings</h2>
        <span className={s.sub}>all-time, from Stripe{summary.updatedAt && !summary.refreshing ? ` · updated ${updatedAgo(summary.updatedAt)}` : summary.refreshing ? ' · counting…' : ''}</span>
        <span className={s.actions}>
          <Button size="small" variant="quiet" icon="plus" onClick={() => openStripe()}>
            Connect Another…
          </Button>
          <Tip label="Count again now">
            <Button size="small" variant="quiet" icon="refresh" aria-label="Refresh all earnings" disabled={summary.refreshing} onClick={() => void api.stripe.refresh()} />
          </Tip>
        </span>
      </div>
      <div className={s.tiles}>
        {summary.projects.length > 1 && main ? (
          <div className={cx(s.tile, s.all)}>
            <span className={s.tileName}>All projects</span>
            <span className={s.amount}>{formatMoney(main.amount, main.currency)}</span>
            <span className={s.others}>{more.map((t) => formatMoney(t.amount, t.currency, true)).join(' · ') || ' '}</span>
          </div>
        ) : null}
        {summary.projects.map(({ project, earnings }) => {
          const [first, ...rest] = earnings.totals ?? [];
          return (
            <Tip key={project.id} label={<EarningsTipBody earnings={earnings} />}>
              <button type="button" className={cx(s.tile, earnings.refreshing && s.counting)} onClick={() => openStripe(project.id)}>
                <span className={s.tileName}>
                  <ProjectIcon id={project.id} name={project.name} size={14} />
                  {project.name}
                  {earnings.mode === 'test' ? <span className={s.test}>test</span> : null}
                  {earnings.error ? <Icon name="alert" size={11} className={s.warn} /> : null}
                </span>
                <span className={s.amount}>{first ? formatMoney(first.amount, first.currency) : earnings.totals ? formatMoney(0, 'usd') : 'Counting…'}</span>
                <span className={s.others}>{rest.map((t) => formatMoney(t.amount, t.currency, true)).join(' · ') || ' '}</span>
              </button>
            </Tip>
          );
        })}
      </div>
    </section>
  );
}
