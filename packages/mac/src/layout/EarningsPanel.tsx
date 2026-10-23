import { Icon } from '../components/Icon.js';
import { Button, Tip, cx } from '../components/ui.js';
import { EarningsTipBody } from '../components/EarningsPill.js';
import { formatMoney, openStripe, updatedAgo, useConverted, useProjectEarnings } from '../lib/earnings.js';
import { brandText } from '../lib/brand.js';
import { useApi, useApp } from '../lib/beluga.js';
import s from './Inspector.module.css';
import e from '../components/earnings.module.css';

/**
 * The Inspector's Earnings row for the project you're in: Connect Stripe when it isn't, the
 * all-time totals and Refresh when it is.
 */
export function EarningsPanel({ projectId }: { projectId: string }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const earnings = useProjectEarnings(project?.root || undefined);
  const money = useConverted(earnings?.totals);
  if (!project?.root) return null;
  if (!earnings) {
    return (
      <section className={s.panel} aria-label="Earnings">
        <div className={s.panelHead}>
          <h3>Earnings</h3>
        </div>
        <div className={s.field}>
          <span className={s.dim}>See what {project.name} earns, from Stripe.</span>
        </div>
        <div className={s.buttons}>
          <Button size="small" icon="coin" onClick={() => openStripe(project.id)}>
            Connect Stripe…
          </Button>
        </div>
      </section>
    );
  }
  const totals = earnings.totals ?? [];
  return (
    <section className={s.panel} aria-label="Earnings">
      <div className={s.panelHead}>
        <h3>Earnings</h3>
        <span className={s.panelActions}>
          <Button size="small" variant="quiet" onClick={() => openStripe(project.id)}>
            Manage…
          </Button>
          <Tip label={earnings.refreshing ? 'Counting…' : 'Count again now'}>
            <Button size="small" variant="quiet" icon="refresh" aria-label="Refresh earnings" disabled={earnings.refreshing} onClick={() => void api.stripe.refresh(project.id)} />
          </Tip>
        </span>
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>All-time</span>
        <span className={cx(s.fieldValue, earnings.refreshing && !totals.length && e.shimmer)}>
          {totals.length ? (
            <Tip label={<EarningsTipBody earnings={earnings} />}>
              <span className={e.num} tabIndex={0}>
                {formatMoney(money.amount, money.currency)}
              </span>
            </Tip>
          ) : earnings.totals ? (
            'Nothing yet'
          ) : (
            'Counting…'
          )}
        </span>
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>Account</span>
        <span className={s.fieldValue}>
          {earnings.account ?? 'Stripe'}
          {earnings.mode === 'test' ? <span className={s.dim}>· test</span> : null}
        </span>
      </div>
      <div className={s.field}>
        <span className={s.fieldLabel}>Updated</span>
        <span className={s.fieldValue}>{earnings.refreshing ? 'Counting…' : updatedAgo(earnings.updatedAt)}</span>
      </div>
      {earnings.error ? (
        <div className={s.field}>
          <span className={s.fieldLabel} />
          <button type="button" className={cx(s.fieldValue, s.tone_warn, s.earningsProblem)} onClick={() => openStripe(project.id)}>
            <Icon name="alert" size={11} />
            {brandText(earnings.error.message)}
          </button>
        </div>
      ) : null}
    </section>
  );
}
