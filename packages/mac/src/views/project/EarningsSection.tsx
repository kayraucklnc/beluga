import { useState } from 'react';
import { EARNINGS_RANGES, type EarningsActivity, type EarningsRange, type FxRates, type MoneyTotal, type PaymentStatus, type RangeDay, type RecentPayment, convertParts, rangeFigures } from '@beluga/core/earnings-store.js';
import type { Project } from '@beluga/workspaces/types.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { IconButton, Segmented, Tip, cx } from '../../components/ui.js';
import { brandText } from '../../lib/brand.js';
import { type ProjectEarnings, formatGlance, formatMoney, missingNote, openStripe, stripePaymentsUrl, updatedAgo, useArrived, useMoney, useProjectEarnings } from '../../lib/earnings.js';
import { openExternal } from '../../lib/system.js';
import { agoText } from './home-model.js';
import s from './earnings-section.module.css';

/**
 * A project's home, with Stripe connected: how it's doing lately. For the last 7, 30 or 90 days
 * (your pick, kept for every project): what it earned, how many payments and paying customers,
 * each against the span before; what came in each day; and the latest payments, filtered to
 * refunds or failed ones when there are any. Money shows in the currency you show earnings in.
 * The Stripe sheet (•••) has the rest. Nothing when Stripe isn't connected.
 */
export function EarningsSection({ project }: { project: Project }) {
  const earnings = useProjectEarnings(project.root);
  if (!earnings) return null;
  return (
    <section className={s.card} aria-label="Earnings">
      <Head project={project} earnings={earnings} />
      {earnings.activity ? <Body activity={earnings.activity} earnings={earnings} /> : <NotYet project={project} earnings={earnings} />}
    </section>
  );
}

const RANGE_KEY = 'beluga.earnings.range.v1';

/** The range you looked at last (30 days at first). */
function useRange(): [EarningsRange, (r: EarningsRange) => void] {
  const [range, setRange] = useState<EarningsRange>(() => {
    try {
      const n = Number(localStorage.getItem(RANGE_KEY));
      return EARNINGS_RANGES.find((r) => r === n) ?? 30;
    } catch {
      return 30;
    }
  });
  return [
    range,
    (r) => {
      setRange(r);
      try {
        localStorage.setItem(RANGE_KEY, String(r));
      } catch {
        // No storage: this page keeps it.
      }
    },
  ];
}

function Head({ project, earnings }: { project: Project; earnings: ProjectEarnings }) {
  const status = earnings.refreshing ? 'reading Stripe…' : earnings.updatedAt ? `updated ${updatedAgo(earnings.updatedAt)}` : undefined;
  return (
    <div className={s.head}>
      <span className={s.headIcon} aria-hidden="true">
        <Icon name="coin" size={14} />
      </span>
      <div className={s.headText}>
        <h3 className={s.title}>Earnings</h3>
        <span className={s.sub}>
          {earnings.account ?? 'Stripe'}
          {earnings.mode === 'test' ? <span className={s.testBadge}>Test</span> : null}
          {status ? <span className={s.dim}> · {status}</span> : null}
        </span>
      </div>
      <IconButton icon="more" label="Stripe Earnings…" onClick={() => openStripe(project.id)} />
    </div>
  );
}

function NotYet({ project, earnings }: { project: Project; earnings: ProjectEarnings }) {
  if (earnings.error && !earnings.refreshing) {
    return (
      <div className={s.problem} role="status">
        <Icon name="alert" size={13} />
        <span>{brandText(earnings.error.message)}</span>
        <button type="button" className={s.link} onClick={() => openStripe(project.id)}>
          Stripe Earnings…
        </button>
      </div>
    );
  }
  return <p className={cx(s.quiet, s.reading)}>Reading the last months from Stripe…</p>;
}

/** The money of some totals in the currency earnings show in (≈ when some was converted). */
interface Shown {
  readonly amount: number;
  readonly approx: boolean;
  readonly missing: readonly MoneyTotal[];
}

const shownOf = (totals: readonly MoneyTotal[], currency: string, fx: FxRates | undefined): Shown => {
  const c = convertParts(totals, currency, fx);
  return { amount: c.amount, approx: c.converted, missing: c.missing };
};

function Body({ activity, earnings }: { activity: EarningsActivity; earnings: ProjectEarnings }) {
  const [range, setRange] = useRange();
  const { currency, fx } = useMoney();
  const fig = rangeFigures(activity, range);
  const earned = shownOf(fig.totals, currency, fx);
  const before = fig.before ? shownOf(fig.before.totals, currency, fx) : undefined;
  const span = `the ${range} days before`;
  const allTime = earnings.totals ? shownOf(earnings.totals, currency, fx) : undefined;
  const note = missingNote(earned.missing);
  return (
    <>
      <div className={s.bar}>
        <Segmented<`${EarningsRange}`>
          label="Range"
          value={`${range}`}
          onChange={(v) => setRange(Number(v) as EarningsRange)}
          options={EARNINGS_RANGES.map((r) => ({ value: `${r}` as const, label: `${r} days`, hint: `The last ${r} days, today included` }))}
        />
        <span className={s.flex} />
        {allTime ? (
          <Tip label={`All-time earnings${allTime.approx ? ', approximate: other currencies converted at the ECB’s rates' : ''}`}>
            <span className={s.allTime}>
              All time <strong>{allTime.approx ? '≈ ' : ''}{formatGlance(allTime.amount, currency)}</strong>
            </span>
          </Tip>
        ) : null}
      </div>
      <div className={s.stats} role="group" aria-label={`The last ${range} days`}>
        <Stat
          icon="coin"
          tone="ok"
          label="Earned"
          value={`${earned.approx ? '≈ ' : ''}${formatGlance(earned.amount, currency)}`}
          tip={`${formatMoney(earned.amount, currency)} in the last ${range} days${before ? `, ${formatMoney(before.amount, currency)} in ${span}` : ''}. Captured minus refunds, before Stripe’s fees.`}
          change={<Change now={earned.amount} before={before?.amount} />}
        />
        <Stat
          icon="check"
          tone="info"
          label="Payments"
          value={fig.payments.toLocaleString()}
          tip={`${fig.payments} successful ${fig.payments === 1 ? 'payment' : 'payments'}${fig.before ? `, ${fig.before.payments} in ${span}` : ''}`}
          change={<Change now={fig.payments} before={fig.before?.payments} />}
        />
        <Stat
          icon="people"
          tone="merged"
          label="Paying customers"
          value={fig.payers === undefined ? '—' : fig.payers.toLocaleString()}
          tip={`Different people who paid, each counted once${fig.before?.payers !== undefined ? `; ${fig.before.payers} in ${span}` : ''}`}
          change={fig.payers === undefined ? null : <Change now={fig.payers} before={fig.before?.payers} />}
        />
      </div>
      <DayBars days={fig.days} currency={currency} fx={fx} />
      {note || activity.partial ? (
        <p className={s.quiet}>
          {note}
          {note && activity.partial ? ' ' : ''}
          {activity.partial ? 'A busy account: Beluga read the newest 5,000 payments, so the oldest days may show only part.' : ''}
        </p>
      ) : null}
      <Latest latest={activity.latest} mode={earnings.mode} />
    </>
  );
}

type Tone = 'ok' | 'info' | 'merged' | 'warn' | 'muted';

function Stat({ icon, tone, label, value, tip, change }: { icon: IconName; tone: Tone; label: string; value: string; tip: string; change: React.ReactNode }) {
  return (
    <Tip label={tip}>
      <div className={s.stat} role="group" aria-label={`${label}: ${value}`}>
        <span className={cx(s.statIcon, s[`tone_${tone}`])} aria-hidden="true">
          <Icon name={icon} size={14} />
        </span>
        <span className={s.statText}>
          <span className={s.statLabel}>{label}</span>
          <span className={s.statValue}>
            {value}
            {change}
          </span>
        </span>
      </div>
    </Tip>
  );
}

/** Up or down against the span before, in percent ("new" when there was nothing then). */
function Change({ now, before }: { now: number; before: number | undefined }) {
  if (before === undefined) return null;
  if (before === 0) return now > 0 ? <span className={cx(s.change, s.up)}>new</span> : null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return <span className={cx(s.change, s.flat)}>±0%</span>;
  return (
    <span className={cx(s.change, pct > 0 ? s.up : s.down)} data-change={pct}>
      {pct > 0 ? '↑' : '↓'} {Math.abs(pct)}%
    </span>
  );
}

const dateOf = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 12);
};
const shortDay = (day: string): string => dateOf(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDay = (day: string): string => dateOf(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** What came in each day: a bar per day, the quiet ones a stub, today's a shade stronger. */
function DayBars({ days, currency, fx }: { days: readonly RangeDay[]; currency: string; fx: FxRates | undefined }) {
  const values = days.map((d) => convertParts(d.totals, currency, fx).amount);
  const max = Math.max(1, ...values);
  return (
    <div className={s.chartWrap}>
      <div className={cx(s.chart, days.length > 40 && s.dense)} role="img" aria-label={`Earned each day, the last ${days.length} days`}>
        {days.map((d, i) => {
          const v = values[i]!;
          return (
            <Tip key={d.day} label={`${longDay(d.day)} · ${v ? `${formatMoney(v, currency)} · ${d.payments} ${d.payments === 1 ? 'payment' : 'payments'}` : 'no payments'}`}>
              <span className={cx(s.col, i === days.length - 1 && s.today)}>
                <span className={cx(s.fill, !v && s.zero)} style={v ? { height: `${Math.max(6, (v / max) * 100)}%` } : undefined} />
              </span>
            </Tip>
          );
        })}
      </div>
      <div className={s.axis} aria-hidden="true">
        <span>{shortDay(days[0]!.day)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

type Filter = 'all' | 'refunds' | 'failed';

const FILTERS: ReadonlyArray<{ value: Filter; label: string; test: (p: RecentPayment) => boolean }> = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'refunds', label: 'Refunds', test: (p) => p.status === 'refunded' || p.status === 'partly_refunded' },
  { value: 'failed', label: 'Failed', test: (p) => p.status === 'failed' },
];

const STATUS: Partial<Record<PaymentStatus, { label: string; tone: Tone }>> = {
  refunded: { label: 'Refunded', tone: 'muted' },
  partly_refunded: { label: 'Part refunded', tone: 'muted' },
  pending: { label: 'Pending', tone: 'info' },
  failed: { label: 'Failed', tone: 'warn' },
};

/** How many of the latest payments show before Show All. */
const FEW = 5;

/** The latest payments, newest first; filters only for kinds there are. */
function Latest({ latest, mode }: { latest: readonly RecentPayment[]; mode: 'test' | 'live' }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [all, setAll] = useState(false);
  const arrived = useArrived(latest);
  const offered = FILTERS.filter((f) => f.value === 'all' || latest.some(f.test));
  const chosen = offered.find((f) => f.value === filter) ?? FILTERS[0]!;
  const list = latest.filter(chosen.test);
  const shown = all ? list : list.slice(0, FEW);
  return (
    <div className={s.latest}>
      <div className={s.latestHead}>
        <h4 className={s.latestTitle}>Latest payments</h4>
        {offered.length > 1 ? (
          <div className={s.filters} role="radiogroup" aria-label="Show">
            {offered.map((f) => (
              <button key={f.value} type="button" role="radio" aria-checked={f.value === chosen.value} className={cx(s.filter, f.value === chosen.value && s.filterOn)} onClick={() => setFilter(f.value)}>
                {f.label}
                {f.value === 'all' ? null : <span className={s.filterCount}>{latest.filter(f.test).length}</span>}
              </button>
            ))}
          </div>
        ) : null}
        <span className={s.flex} />
        <button type="button" className={s.link} onClick={() => void openExternal(stripePaymentsUrl(mode))}>
          Open Stripe
          <Icon name="external" size={10} />
        </button>
      </div>
      {shown.length ? (
        <div className={s.rows} role="list" aria-label="Latest payments">
          {shown.map((p) => (
            <PaymentRow key={p.id} payment={p} fresh={arrived.has(p.id)} />
          ))}
        </div>
      ) : (
        <p className={s.quiet}>{latest.length ? 'None of these lately.' : 'No payments in the last six months.'}</p>
      )}
      {list.length > FEW ? (
        <button type="button" className={cx(s.link, s.more)} onClick={() => setAll(!all)}>
          {all ? 'Show Fewer' : `Show All ${list.length}`}
        </button>
      ) : null}
    </div>
  );
}

const AVATAR_TONES: readonly Tone[] = ['ok', 'info', 'merged', 'warn'];
const toneFor = (text: string): Tone => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length]!;
};

function PaymentRow({ payment: p, fresh }: { payment: RecentPayment; fresh: boolean }) {
  const status = STATUS[p.status];
  const who = p.who ?? 'A customer';
  const gone = p.status === 'refunded' || p.status === 'failed';
  return (
    <div role="listitem" className={cx(s.pay, fresh && s.fresh)} data-payment={p.status}>
      <span className={cx(s.avatar, s[`tone_${p.who ? toneFor(p.who) : 'muted'}`])} aria-hidden="true">
        {p.who ? p.who[0]!.toUpperCase() : <Icon name="person" size={12} />}
      </span>
      <span className={s.payMain}>
        <span className={s.payWho}>{who}</span>
        {p.description ? <span className={s.payWhat}>{p.description}</span> : null}
      </span>
      {fresh ? <span className={cx(s.badge, s.badgeNew)}>New</span> : null}
      {status ? <span className={cx(s.badge, s[`badge_${status.tone}`])}>{status.label}</span> : null}
      <Tip label={p.refunded && p.status === 'partly_refunded' ? `${formatMoney(p.refunded, p.currency)} refunded` : new Date(p.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>
        <span className={cx(s.payAmount, gone && s.struck)}>{formatMoney(p.amount, p.currency)}</span>
      </Tip>
      <span className={s.payWhen}>{agoText(p.at)}</span>
    </div>
  );
}
