import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon.js';
import { ViewBlock } from '../../components/views/ViewBlock.js';
import { usePrefs } from '../../lib/prefs.js';
import { SPRING } from '../fx.js';
import s from './scenes.module.css';

/**
 * The table weave: asked about a database, Claude finds how to reach it, picks the protocol
 * (Postgres here, of Postgres, SQLite and MySQL), connects, runs its query, and the answer
 * arrives as a real table in the chat, the same one conversations show (ViewBlock): its
 * headings sort, it turns into a chart, it opens in a full window. It plays once, then it's yours.
 */

const PROTOCOLS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'postgres', label: 'Postgres' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'mysql', label: 'MySQL' },
];

const VIEW = JSON.stringify({
  type: 'table',
  title: 'Churned last month',
  summary: 'subscriptions · 5 rows',
  columns: [
    { key: 'customer', label: 'Customer' },
    { key: 'plan', label: 'Plan', type: 'badge' },
    { key: 'mrr', label: 'MRR', type: 'currency', currency: 'USD' },
    { key: 'left', label: 'Left on', type: 'date' },
  ],
  data: [
    { customer: 'Northwind', plan: 'Team', mrr: 480, left: '2026-09-04' },
    { customer: 'Acme Labs', plan: 'Pro', mrr: 120, left: '2026-09-11' },
    { customer: 'Globex', plan: 'Team', mrr: 960, left: '2026-09-17' },
    { customer: 'Initech', plan: 'Starter', mrr: 29, left: '2026-09-22' },
    { customer: 'Umbrella', plan: 'Pro', mrr: 240, left: '2026-09-28' },
  ],
});

interface Line {
  readonly icon: IconName;
  readonly text: string;
  readonly code: string;
}

const LINES: readonly Line[] = [
  { icon: 'file', text: 'Found', code: 'DATABASE_URL in .env' },
  { icon: 'link', text: 'Connected to', code: 'localhost:5432/shop' },
  { icon: 'terminal', text: 'Queried', code: 'SELECT … FROM subscriptions' },
];

// Beats (ms each): the question, finding the database, picking the protocol, connecting,
// querying, and the table (where it stays).
const BEATS = [900, 1000, 1100, 1000, 900] as const;
const LAST = BEATS.length;

/** Plays through once and holds on the table (with Reduce Motion: the table at once). */
function useOnce(): number {
  const still = (useReducedMotion() ?? false) || usePrefs().reduceMotion;
  const [beat, setBeat] = useState(still ? LAST : 0);
  useEffect(() => {
    if (still) return setBeat(LAST);
    if (beat >= LAST) return;
    const t = setTimeout(() => setBeat(beat + 1), BEATS[beat]);
    return () => clearTimeout(t);
  }, [beat, still]);
  return beat;
}

export function Tables() {
  const beat = useOnce();
  const picking = beat >= 1;
  const picked = beat >= 2;
  // Lines shown: Found from beat 1, Connected from 3, Queried from 4.
  const lines = beat >= 4 ? 3 : beat >= 3 ? 2 : beat >= 1 ? 1 : 0;
  const working = beat < LAST;
  const table = beat >= LAST;
  return (
    <div className={s.stage}>
      <div className={s.tables}>
        <div className={s.windowBar}>
          <span className={s.lights}>
            <i />
            <i />
            <i />
          </span>
          <span className={s.mono}>shop · main</span>
          {working ? (
            <span className={s.live}>
              <span className={s.liveDot} /> Working
            </span>
          ) : null}
        </div>
        <div className={s.tablesChat}>
          <div className={s.ask}>Which customers churned last month?</div>
          <AnimatePresence mode="wait" initial={false}>
            {table ? (
              // Once Claude answers, its steps fold away (as they do in a conversation).
              <motion.div key="folded" className={s.folded} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
                <Icon name="check" size={12} className={s.done} />
                <span>3 steps</span>
                <span className={s.protocol} data-on>
                  <Icon name="grid" size={10} /> Postgres
                </span>
                <span className={s.dim}>localhost:5432/shop</span>
              </motion.div>
            ) : (
              <motion.div key="steps" className={s.steps} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25 }}>
                <AnimatePresence initial={false}>
                  {LINES.slice(0, lines).map((l, i) => {
                    const busy = i === lines - 1 && !(i === 0 && picked);
                    return (
                      <motion.div key={l.text} className={s.step} initial={{ opacity: 0, x: -10, filter: 'blur(4px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }} transition={SPRING}>
                        <Icon name={busy ? 'refresh' : 'check'} size={12} className={busy ? s.spin : s.done} />
                        <span>{l.text}</span>
                        <code>{l.code}</code>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                <AnimatePresence initial={false}>
                  {picking ? (
                    <motion.div key="protocols" className={s.protocols} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
                      <span className={s.dim}>{picked ? 'Protocol' : 'Picking a protocol'}</span>
                      {PROTOCOLS.map((p, i) => {
                        const chosen = picked && p.id === 'postgres';
                        return (
                          <motion.span key={p.id} className={s.protocol} data-on={chosen || undefined} animate={{ opacity: picked && !chosen ? 0.35 : 1, scale: chosen ? 1.04 : 1 }} transition={{ ...SPRING, delay: picked ? 0 : i * 0.08 }}>
                            <Icon name={chosen ? 'check' : 'grid'} size={10} />
                            {p.label}
                          </motion.span>
                        );
                      })}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {table ? (
              <motion.div key="table" className={s.weave} initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 22 }}>
                <ViewBlock code={VIEW} type="table" />
                <div className={s.weaveTry}>
                  <Icon name="hand" size={11} /> It’s the real table: click a heading to sort, or turn it into a chart.
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
