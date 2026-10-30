import { memo } from 'react';
import type { LogItem, ShippedMark } from '@beluga/core/store.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { openExternal } from '../lib/system.js';
import s from './context.module.css';

export type ShippedItem = Extract<LogItem, { type: 'system' }> & { readonly shipped: ShippedMark };

export const isShippedItem = (l: LogItem): l is ShippedItem => l.type === 'system' && Boolean((l as { shipped?: ShippedMark }).shipped);

/**
 * Continue After Merge: the chat above went out in a pull request that merged, and what's below
 * is new work for the next one. The PR number opens it on GitHub.
 */
export const ShippedDivider = memo(function ShippedDivider({ item }: { item: ShippedItem }) {
  const m = item.shipped;
  const pr = `PR #${m.number}`;
  return (
    <div className={cx(s.divider, s.shipped)} data-shipped-divider={m.number} role="separator" aria-label={item.text}>
      <div className={s.rule}>
        <span className={s.label}>
          <Icon name="merge" size={11} />
          <span>
            Above went to{' '}
            {m.url ? (
              <button type="button" className={s.prLink} onClick={() => void openExternal(m.url!)} title={`Open ${pr} on GitHub`}>
                {pr}
              </button>
            ) : (
              pr
            )}
            , merged into {m.into}
          </span>
        </span>
      </div>
      <div className={s.fresh}>New start: the next change gets a new pull request</div>
    </div>
  );
});
