import type { ProjectEarnings } from '@klaud/core/earnings-store.js';
import { useEffect, useRef, useState } from 'react';
import { combinedTotal, formatMoney, openStripe, updatedAgo, useMoney, useProjectEarnings } from '../lib/earnings.js';
import { brandText } from '../lib/brand.js';
import { Icon } from './Icon.js';
import { Tip, cx } from './ui.js';
import s from './earnings.module.css';

/** What the tooltip says: the total, each currency on its own when there are several, how fresh, what went wrong. */
export function EarningsTipBody({ earnings }: { earnings: ProjectEarnings }) {
  const { currency, fx } = useMoney();
  const totals = earnings.totals ?? [];
  const combined = combinedTotal(totals, currency, fx);
  const several = totals.length > 1;
  const head = earnings.refreshing && !earnings.totals ? 'Counting all-time earnings from Stripe…' : `All-time earnings · ${earnings.refreshing ? 'updating…' : `updated ${updatedAgo(earnings.updatedAt)}`}`;
  return (
    <span className={s.tipBody}>
      <span>{head}</span>
      {several && combined !== undefined ? <span className={s.tipTotal}>≈ {formatMoney(combined, currency)} in all</span> : null}
      {several
        ? totals.map((t) => (
            <span key={t.currency} className={s.tipLine}>
              <span>{t.currency.toUpperCase()}</span>
              <span className={s.num}>{formatMoney(t.amount, t.currency)}</span>
            </span>
          ))
        : null}
      {several && fx ? <span className={s.tipDim}>Added up at the European Central Bank’s rates of {new Date(fx.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}; approximate.</span> : null}
      {earnings.mode === 'test' ? <span className={s.tipDim}>Test mode</span> : null}
      {earnings.error ? <span className={s.tipError}>{brandText(earnings.error.message)}</span> : null}
    </span>
  );
}

/** Pulses for a moment when the amount changes (a new sale counted), not on first show. */
function useChanged(value: string): boolean {
  const last = useRef(value);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1200);
    return () => clearTimeout(t);
  }, [value]);
  return pulse;
}

/**
 * A project's all-time earnings beside its name in the sidebar: one amount, compact ("$12.4K"),
 * in your main currency (several currencies are added up at today's rates; each shows on
 * hover). Just the figure, in a quiet money green; it shimmers while Stripe is being read and
 * glows briefly when it grows.
 * Clicking it opens the project's Stripe sheet. Nothing when Stripe isn't connected.
 */
export function EarningsPill({ root, projectId }: { root: string | undefined; projectId: string }) {
  const earnings = useProjectEarnings(root);
  const { currency, fx } = useMoney();
  const totals = earnings?.totals ?? [];
  const combined = combinedTotal(totals, currency, fx);
  // Without rates for some currency: its biggest total, as before.
  const shown = combined !== undefined ? { amount: combined, currency } : totals[0];
  const label = shown ? formatMoney(shown.amount, shown.currency, true) : earnings?.totals ? formatMoney(0, currency, true) : '';
  const pulse = useChanged(label);
  if (!earnings) return null;
  const failed = Boolean(earnings.error) && !shown;
  return (
    <Tip label={<EarningsTipBody earnings={earnings} />}>
      <button
        type="button"
        className={cx(s.pill, earnings.refreshing && s.shimmer, earnings.mode === 'test' && s.test, failed && s.failed, earnings.error && shown && s.stale, !shown && !failed && !earnings.totals && s.pending, pulse && s.pulse)}
        aria-label={shown ? `All-time earnings ${totals.length > 1 ? 'about ' : ''}${formatMoney(shown.amount, shown.currency)}` : failed ? 'Stripe earnings: a problem' : 'Counting earnings'}
        data-earnings-pill={projectId}
        onClick={(e) => {
          e.stopPropagation();
          openStripe(projectId);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {failed ? <Icon name="alert" size={10} /> : null}
        {label ? <span className={s.num}>{label}</span> : null}
      </button>
    </Tip>
  );
}
