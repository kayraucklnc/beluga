import type { ProjectEarnings } from '@beluga/core/earnings-store.js';
import { useEffect, useRef, useState } from 'react';
import { formatMoney, missingNote, openStripe, ratesWhen, updatedAgo, useConverted, useMoney, useProjectEarnings } from '../lib/earnings.js';
import { brandText } from '../lib/brand.js';
import { Icon } from './Icon.js';
import { Tip, cx } from './ui.js';
import s from './earnings.module.css';

/**
 * What a project's tooltip says: its total in the currency earnings are shown in, what it earned in
 * each currency when that's another (or several), how fresh, what went wrong.
 */
export function EarningsTipBody({ earnings }: { earnings: ProjectEarnings }) {
  const { fx } = useMoney();
  const totals = earnings.totals ?? [];
  const money = useConverted(totals);
  const breakdown = money.converted || money.missing.length > 0;
  const note = missingNote(money.missing);
  const head = earnings.refreshing && !earnings.totals ? 'Counting all-time earnings from Stripe…' : `All-time earnings · ${earnings.refreshing ? 'updating…' : `updated ${updatedAgo(earnings.updatedAt)}`}`;
  return (
    <span className={s.tipBody}>
      <span>{head}</span>
      {breakdown ? <span className={s.tipTotal}>≈ {formatMoney(money.amount, money.currency)}</span> : totals.length ? <span className={s.tipTotal}>{formatMoney(money.amount, money.currency)}</span> : null}
      {breakdown
        ? totals.map((t) => (
            <span key={t.currency} className={s.tipLine}>
              <span>{t.currency.toUpperCase()}</span>
              <span className={s.num}>{formatMoney(t.amount, t.currency)}</span>
            </span>
          ))
        : null}
      {note ? <span className={s.tipDim}>{note}</span> : null}
      {money.converted && fx ? <span className={s.tipDim}>Converted at the European Central Bank’s rates, updated {ratesWhen(fx.at)}; approximate.</span> : null}
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
 * in the currency you show earnings in (other currencies converted at today's rates; each shows
 * on hover). Just the figure, in a quiet money green; it shimmers while Stripe is being read and
 * glows briefly when it grows.
 * Clicking it opens the project's Stripe sheet. Nothing when Stripe isn't connected.
 */
export function EarningsPill({ root, projectId }: { root: string | undefined; projectId: string }) {
  const earnings = useProjectEarnings(root);
  const totals = earnings?.totals ?? [];
  const money = useConverted(totals);
  // Nothing has a rate yet: its biggest total, as it is.
  const nothingConverts = totals.length > 0 && money.missing.length === totals.length;
  const shown = totals.length ? (nothingConverts ? totals[0] : { amount: money.amount, currency: money.currency }) : undefined;
  const label = shown ? formatMoney(shown.amount, shown.currency, true) : earnings?.totals ? formatMoney(0, money.currency, true) : '';
  const pulse = useChanged(label);
  if (!earnings) return null;
  const failed = Boolean(earnings.error) && !shown;
  return (
    <Tip label={<EarningsTipBody earnings={earnings} />}>
      <button
        type="button"
        className={cx(s.pill, earnings.refreshing && s.shimmer, earnings.mode === 'test' && s.test, failed && s.failed, earnings.error && shown && s.stale, !shown && !failed && !earnings.totals && s.pending, pulse && s.pulse)}
        aria-label={shown ? `All-time earnings ${money.converted ? 'about ' : ''}${formatMoney(shown.amount, shown.currency)}` : failed ? 'Stripe earnings: a problem' : 'Counting earnings'}
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
