import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../../components/Icon.js';
import { SPRING } from '../fx.js';
import { useBeats } from './use-beats.js';
import s from './scenes.module.css';

/**
 * Friends, and their Claudes: two Macs joined by an encrypted line. Ada's Claude asks to run
 * something on yours; the request comes to you, you allow it, and the result goes back. You
 * always see what's asked and decide.
 */

// Beats: quiet, the request travels, it waits for you, you allow, the answer travels back.
const BEATS = [900, 1100, 1500, 900, 1400, 1600] as const;

function Person({ name, hue, you }: { readonly name: string; readonly hue: number; readonly you?: boolean }) {
  return (
    <div className={s.person}>
      <span className={s.avatar} style={{ background: `oklch(0.7 0.11 ${hue})` }}>
        {name[0]}
      </span>
      <strong>{you ? 'You' : name}</strong>
      <span className={s.theirClaude}>
        <Icon name="claude" size={11} /> {you ? 'your Claude' : `${name}’s Claude`}
      </span>
    </div>
  );
}

export function Friends() {
  const beat = useBeats(BEATS, 3);
  const asking = beat === 1;
  const waiting = beat >= 2 && beat <= 3;
  const allowed = beat >= 3;
  const returning = beat === 4;
  const done = beat >= 5;
  return (
    <div className={s.stage}>
      <div className={s.friends}>
        <Person name="Ada" hue={300} />
        <div className={s.wire}>
          <svg className={s.wireSvg} viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="beam" x1="0" x2="1">
                <stop offset="0" stopColor="var(--claude)" stopOpacity="0" />
                <stop offset="0.5" stopColor="var(--claude)" stopOpacity="1" />
                <stop offset="1" stopColor="var(--claude)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0 20 C 100 2, 200 38, 300 20" className={s.wireBase} />
            {asking || returning ? (
              <motion.path
                key={asking ? 'there' : 'back'}
                d={asking ? 'M0 20 C 100 2, 200 38, 300 20' : 'M300 20 C 200 38, 100 2, 0 20'}
                stroke="url(#beam)"
                strokeWidth="2.5"
                fill="none"
                initial={{ pathLength: 0.18, pathOffset: 0 }}
                animate={{ pathOffset: 1 }}
                transition={{ duration: 1, ease: [0.45, 0, 0.2, 1] }}
              />
            ) : null}
          </svg>
          <span className={s.lock}>
            <Icon name="lock" size={11} /> End-to-end encrypted
          </span>
          <AnimatePresence>
            {asking ? (
              <motion.span key="packet" className={s.packet} initial={{ left: '0%', opacity: 0 }} animate={{ left: '100%', opacity: [0, 1, 1, 0] }} transition={{ duration: 1, ease: [0.45, 0, 0.2, 1] }}>
                <code>npm test</code>
              </motion.span>
            ) : null}
            {returning ? (
              <motion.span key="result" className={s.packet} data-tone="ok" initial={{ left: '100%', opacity: 0 }} animate={{ left: '0%', opacity: [0, 1, 1, 0] }} transition={{ duration: 1, ease: [0.45, 0, 0.2, 1] }}>
                <Icon name="check" size={11} /> 42 passed
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
        <div className={s.youSide}>
          <Person name="You" hue={40} you />
          <AnimatePresence>
            {waiting ? (
              <motion.div key="req" className={s.request} initial={{ opacity: 0, y: 12, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }} transition={SPRING}>
                <span className={s.dim}>Ada’s Claude wants to run</span>
                <code>npm test</code>
                <span className={s.dim}>in web · feat/checkout-v2</span>
                <div className={s.requestButtons}>
                  <span className={s.btn}>Decline</span>
                  <motion.span className={s.btnPrimary} animate={allowed ? { scale: [1, 0.92, 1] } : {}} transition={{ duration: 0.3 }}>
                    {allowed ? <Icon name="check" size={11} /> : null} Allow
                  </motion.span>
                </div>
              </motion.div>
            ) : null}
            {done ? (
              <motion.div key="done" className={s.doneNote} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={SPRING}>
                <Icon name="check" size={12} /> Ran on your Mac, sent back to Ada
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
