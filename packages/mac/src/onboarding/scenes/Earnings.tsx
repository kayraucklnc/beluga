import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../../components/Icon.js';
import { EASE_OUT, SPRING, Ticker } from '../fx.js';
import { useBeats } from './use-beats.js';
import s from './scenes.module.css';

/**
 * What each project earns: connect Stripe and every project shows its revenue next to the
 * work. Bars grow, the month's total counts up, and a new sale lands while you watch.
 */

const PROJECTS: ReadonlyArray<{ name: string; amount: number; trend: readonly number[] }> = [
  { name: 'web', amount: 8420, trend: [3, 4, 4, 6, 5, 7, 9] },
  { name: 'ios', amount: 3110, trend: [2, 2, 3, 3, 4, 4, 5] },
  { name: 'api', amount: 950, trend: [1, 2, 1, 2, 2, 3, 3] },
];
const SALE = 49;
const MAX = PROJECTS[0]!.amount + SALE;
const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

function Spark({ points }: { readonly points: readonly number[] }) {
  const top = Math.max(...points);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * 60} ${18 - (p / top) * 16}`).join(' ');
  return (
    <svg width="60" height="20" viewBox="0 0 60 20" aria-hidden="true" className={s.spark}>
      <motion.path d={d} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2, ease: EASE_OUT, delay: 0.4 }} />
    </svg>
  );
}

export function Earnings() {
  // Beats: the month so far, then a new sale for web.
  const beat = useBeats([2600, 2800], 1);
  const sold = beat === 1;
  const total = PROJECTS.reduce((sum, p) => sum + p.amount, 0) + (sold ? SALE : 0);
  return (
    <div className={s.stage} style={{ perspective: 1400 }}>
      <motion.div className={s.earnings} initial={{ rotateX: 10, rotateY: -14 }} animate={{ rotateX: 10, rotateY: -14 }}>
        <div className={s.earnHead}>
          <div>
            <span className={s.dim}>This month</span>
            <strong className={s.total}>
              {/* When the sale lands it counts on from the month so far, not from zero. */}
              <Ticker key={sold ? 'after' : 'before'} value={total} from={sold ? total - SALE : 0} format={money} duration={sold ? 0.6 : 1.6} />
            </strong>
          </div>
          <span className={s.stripe}>
            <span className={s.stripeDot} /> Stripe connected
          </span>
        </div>
        {PROJECTS.map((p, i) => {
          const amount = p.amount + (sold && i === 0 ? SALE : 0);
          return (
            <div key={p.name} className={s.earnRow}>
              <Icon name="folder" size={12} />
              <span className={s.earnName}>{p.name}</span>
              <span className={s.earnBar}>
                <motion.span className={s.earnFill} initial={{ scaleX: 0 }} animate={{ scaleX: amount / MAX }} transition={{ duration: 1.3, ease: EASE_OUT, delay: 0.15 + i * 0.12 }} />
              </span>
              <Spark points={p.trend} />
              <span className={s.earnAmount}>{money(amount)}</span>
            </div>
          );
        })}
        <AnimatePresence>
          {sold ? (
            <motion.div key="sale" className={s.sale} initial={{ opacity: 0, y: 16, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} transition={SPRING}>
              <span className={s.saleIcon}>+</span>
              <span>
                <strong>{money(SALE)}</strong> new subscription · web
              </span>
              <span className={s.dim}>just now</span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
