import { EarningsTipBody } from '../../components/EarningsPill.js';
import { Icon } from '../../components/Icon.js';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { Button, Tip, cx } from '../../components/ui.js';
import { type ConnectedProject, formatMoney, openStripe, updatedAgo, useEarnings } from '../../lib/earnings.js';
import { useApp } from '../../lib/klaud.js';
import { Bar, Card, slotColor } from './parts.js';
import { slotOf } from './usage-model.js';
import s from './usage.module.css';

/** One connected project: its name, its share of the biggest earner (same currency), and its total. */
function EarningsRow({ item, top, currency }: { item: ConnectedProject; top: number; currency: string | undefined }) {
  const projects = useApp((st) => st.projects);
  const { project, earnings } = item;
  const [first, ...rest] = earnings.totals ?? [];
  const comparable = first && first.currency === currency ? first.amount : 0;
  const amount = first ? formatMoney(first.amount, first.currency) : earnings.totals ? formatMoney(0, 'usd') : 'Counting…';
  return (
    <li>
      <Tip label={<EarningsTipBody earnings={earnings} />}>
        <button type="button" className={cx(s.earnRow, earnings.refreshing && s.earnCounting)} onClick={() => openStripe(project.id)} aria-label={`${project.name}: ${amount}`}>
          <span className={s.earnName}>
            <ProjectIcon id={project.id} name={project.name} size={14} />
            <span className={s.earnLabel}>{project.name}</span>
            {earnings.mode === 'test' ? <span className={s.earnTest}>test</span> : null}
            {earnings.error ? <Icon name="alert" size={11} className={s.alertWarn} /> : null}
          </span>
          <Bar value={comparable} max={top} color={slotColor(slotOf(projects, project))} />
          <span className={s.earnAmount}>
            {amount}
            {rest.length ? <small>{` + ${rest.map((t) => formatMoney(t.amount, t.currency, true)).join(' + ')}`}</small> : null}
          </span>
        </button>
      </Tip>
    </li>
  );
}

/**
 * The Usage view's third card: what projects with Stripe connected earned, all-time (the biggest
 * earner first), each opening its earnings sheet. With none connected, a quiet way to connect one.
 */
export function EarningsSummaryCard() {
  const summary = useEarnings();
  if (!summary.projects.length) {
    return (
      <Card label="Earnings" title="Earnings" className={s.earnCard}>
        <p className={s.quiet}>Connect Stripe to a project and what it has earned, all-time, shows here and beside it in the sidebar.</p>
        <div className={s.earnConnect}>
          <Button size="small" icon="coin" onClick={() => openStripe()}>
            Connect Stripe…
          </Button>
        </div>
      </Card>
    );
  }
  const [main, ...more] = summary.totals;
  const top = Math.max(0, ...summary.projects.map((c) => (c.earnings.totals?.[0]?.currency === main?.currency ? (c.earnings.totals?.[0]?.amount ?? 0) : 0)));
  const status = summary.refreshing ? 'Counting…' : summary.updatedAt ? `Updated ${updatedAgo(summary.updatedAt)}` : undefined;
  return (
    <Card label="Earnings" title="Earnings" className={s.earnCard} aside={status ? <span className={s.updated}>{status}</span> : undefined}>
      <div className={s.earnBody}>
        <div>
          <div className={s.hero}>
            <span className={s.heroValue}>{main ? formatMoney(main.amount, main.currency) : '—'}</span>
            <span className={s.heroUnit}>all time</span>
            {more.length ? <span className={s.heroCost}>{more.map((t) => `+ ${formatMoney(t.amount, t.currency, true)}`).join(' ')}</span> : null}
          </div>
          <div className={s.heroFoot}>
            <span>
              From Stripe · <strong>{summary.projects.length}</strong> {summary.projects.length === 1 ? 'project' : 'projects'}
            </span>
            <Button size="small" variant="quiet" icon="plus" className={s.earnAdd} onClick={() => openStripe()}>
              Connect Another…
            </Button>
          </div>
        </div>
        <ul className={s.earnList} aria-label="Earnings by project">
          {summary.projects.map((item) => (
            <EarningsRow key={item.project.id} item={item} top={top} currency={main?.currency} />
          ))}
        </ul>
      </div>
    </Card>
  );
}
