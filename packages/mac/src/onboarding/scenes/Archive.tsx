import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../../components/Icon.js';
import { SPRING, Ticker } from '../fx.js';
import { useBeats } from './use-beats.js';
import s from './scenes.module.css';

/**
 * Archive without thinking twice. It's what archiving does (workspaces/manager.ts): the
 * worktree's folder goes, with its node_modules and builds, while its branch and conversation
 * fold into a small capsule on the shelf. Restore checks the branch out again.
 */

const CARDS: ReadonlyArray<{ label: string; kept: boolean }> = [
  { label: 'Folder · node_modules, builds', kept: false },
  { label: 'Conversation · 214 messages', kept: true },
  { label: 'Branch · fix/safari-scroll', kept: true },
];
const FULL_MB = 1240;
const PACKED_MB = 0.6;

const size = (mb: number): string => (mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`);

// Beats: the worktree as it is, folding, on the shelf, restored.
const BEATS = [1800, 1100, 2200, 1500] as const;

export function Archive() {
  const beat = useBeats(BEATS, 2);
  const packed = beat === 1 || beat === 2;
  const restored = beat === 3;
  return (
    <div className={s.stage} style={{ perspective: 1200 }}>
      <div className={s.archive}>
        <div className={s.pile}>
          {CARDS.map(({ label, kept }, i) => (
            <motion.div
              key={label}
              className={s.card}
              data-kept={kept}
              animate={
                packed
                  ? kept
                    ? { y: 40, scaleY: 0.12, scaleX: 0.5, opacity: 0, rotateX: 60, filter: 'blur(0px)' }
                    : { y: 0, scale: 1.08, opacity: 0, filter: 'blur(10px)' }
                  : { y: i * 52, scaleY: 1, scaleX: 1, scale: 1, opacity: 1, rotateX: 0, filter: 'blur(0px)' }
              }
              transition={{ type: 'spring', stiffness: 170, damping: 20, delay: packed ? i * 0.06 : (CARDS.length - i) * 0.05 }}
            >
              <span className={s.cardLine} />
              <span>{label}</span>
              <span className={s.cardTag}>{kept ? 'kept' : 'removed'}</span>
            </motion.div>
          ))}
          <AnimatePresence>
            {/* The capsule forms as the cards fold into it. */}
          {packed ? (
              <motion.div key="capsule" className={s.capsule} initial={{ opacity: 0, scale: 0.6, y: 40 }} animate={{ opacity: 1, scale: 1, y: 52 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ ...SPRING, delay: 0.35 }}>
                <Icon name="archive" size={13} />
                <span className={s.mono}>fix/safari-scroll</span>
                <span className={s.dim}>archived</span>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <div className={s.size}>
          <span className={s.dim}>On disk</span>
          <strong>
            <Ticker key={packed ? 'packed' : restored ? 'restored' : 'full'} value={packed ? PACKED_MB : FULL_MB} from={packed ? FULL_MB : restored ? PACKED_MB : FULL_MB} format={size} duration={packed ? 1.2 : 0.8} />
          </strong>
          <span className={s.saved} data-on={packed}>
            {packed ? 'Only the branch and the conversation stay' : restored ? 'Checked out again, every message intact' : 'A finished worktree'}
          </span>
        </div>
      </div>
    </div>
  );
}
