import type { ProjectEarnings } from '@klaud/core/earnings-store.js';
import { formatMoney, openStripe, updatedAgo, useProjectEarnings } from '../lib/earnings.js';
import { Icon } from './Icon.js';
import { Tip, cx } from './ui.js';
import s from './earnings.module.css';

/** What the tooltip says: all-time, how fresh, every currency when there are several, what went wrong. */
export function EarningsTipBody({ earnings }: { earnings: ProjectEarnings }) {
  const totals = earnings.totals ?? [];
  const head = earnings.refreshing && !earnings.totals ? 'Counting all-time earnings from Stripe…' : `All-time earnings · ${earnings.refreshing ? 'updating…' : `updated ${updatedAgo(earnings.updatedAt)}`}`;
  return (
    <span className={s.tipBody}>
      <span>{head}</span>
      {totals.length > 1
        ? totals.map((t) => (
            <span key={t.currency} className={s.tipLine}>
              <span>{t.currency.toUpperCase()}</span>
              <span className={s.num}>{formatMoney(t.amount, t.currency)}</span>
            </span>
          ))
        : null}
      {earnings.mode === 'test' ? <span className={s.tipDim}>Test mode</span> : null}
      {earnings.error ? <span className={s.tipError}>{earnings.error.message}</span> : null}
    </span>
  );
}

/**
 * A project's all-time earnings, small and quiet beside its name in the sidebar: the main
 * currency, compact ("$12.4K"), "+1" when there are more. It shimmers while Stripe is being
 * read, and clicking it opens the project's Stripe sheet. Nothing when Stripe isn't connected.
 */
export function EarningsPill({ root, projectId }: { root: string | undefined; projectId: string }) {
  const earnings = useProjectEarnings(root);
  if (!earnings) return null;
  const main = earnings.totals?.[0];
  const more = (earnings.totals?.length ?? 0) - 1;
  const failed = Boolean(earnings.error) && !main;
  // Connected and counted, but nothing earned yet: a plain 0.
  const label = main ? formatMoney(main.amount, main.currency, true) : earnings.totals ? '0' : '';
  return (
    <Tip label={<EarningsTipBody earnings={earnings} />}>
      <button
        type="button"
        className={cx(s.pill, earnings.refreshing && s.shimmer, earnings.mode === 'test' && s.test, failed && s.failed, earnings.error && main && s.stale, !main && !failed && !earnings.totals && s.pending)}
        aria-label={main ? `All-time earnings ${formatMoney(main.amount, main.currency)}${more > 0 ? ` and ${more} more ${more === 1 ? 'currency' : 'currencies'}` : ''}` : failed ? 'Stripe earnings: a problem' : 'Counting earnings'}
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
        {more > 0 ? <span className={s.more}>+{more}</span> : null}
      </button>
    </Tip>
  );
}
