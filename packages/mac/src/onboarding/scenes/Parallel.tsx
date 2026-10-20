import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../../components/Icon.js';
import { EASE_OUT, SPRING } from '../fx.js';
import { useBeats } from './use-beats.js';
import s from './scenes.module.css';

/**
 * Work on everything at once: three repositories stacked in depth, the one in front cycling.
 * Each has its own worktrees on their own branches, every one with a Claude moving it along,
 * from working to a pull request to merged.
 */

type Status = 'working' | 'pr' | 'merged';
interface Lane {
  readonly branch: string;
  readonly steps: readonly Status[];
}
interface Repo {
  readonly name: string;
  readonly lanes: readonly Lane[];
}

const REPOS: readonly Repo[] = [
  {
    name: 'web',
    lanes: [
      { branch: 'feat/checkout-v2', steps: ['working', 'working', 'pr'] },
      { branch: 'fix/safari-scroll', steps: ['working', 'pr', 'merged'] },
      { branch: 'feat/dark-charts', steps: ['working', 'working', 'working'] },
    ],
  },
  {
    name: 'api',
    lanes: [
      { branch: 'feat/rate-limits', steps: ['working', 'pr', 'pr'] },
      { branch: 'perf/query-cache', steps: ['working', 'working', 'merged'] },
      { branch: 'fix/webhook-retry', steps: ['pr', 'merged', 'merged'] },
    ],
  },
  {
    name: 'ios',
    lanes: [
      { branch: 'feat/widgets', steps: ['working', 'working', 'pr'] },
      { branch: 'fix/push-tokens', steps: ['working', 'pr', 'merged'] },
      { branch: 'chore/swift-6', steps: ['working', 'working', 'working'] },
    ],
  },
];

const BEAT_MS = 1500;
const LABEL: Record<Status, string> = { working: 'Claude working', pr: 'Pull request', merged: 'Merged' };
const ICON: Record<Status, 'spark' | 'pr' | 'merge'> = { working: 'spark', pr: 'pr', merged: 'merge' };

function LaneRow({ lane, step, live }: { readonly lane: Lane; readonly step: number; readonly live: boolean }) {
  const status = lane.steps[Math.min(step, lane.steps.length - 1)]!;
  return (
    <div className={s.lane}>
      <Icon name="branch" size={12} />
      <span className={s.mono}>{lane.branch}</span>
      <span className={s.track}>
        <motion.span className={s.fill} data-status={status} animate={{ scaleX: status === 'working' ? 0.35 + step * 0.22 : 1 }} transition={{ duration: 1.1, ease: EASE_OUT }} />
        {status === 'working' && live ? <span className={s.shimmer} /> : null}
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={status} className={s.pill} data-status={status} initial={{ opacity: 0, y: 6, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.9 }} transition={SPRING}>
          <Icon name={ICON[status]} size={11} />
          {LABEL[status]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export function Parallel() {
  // Nine beats: three repositories in front in turn, three steps each.
  const beat = useBeats(Array.from({ length: 9 }, () => BEAT_MS), 2);
  const front = Math.floor(beat / 3);
  const step = beat % 3;
  return (
    <div className={s.stage} style={{ perspective: 1400 }}>
      <div className={s.parallel}>
        {REPOS.map((repo, i) => {
          // 0 in front, then 1 and 2 behind it.
          const depth = (i - front + REPOS.length) % REPOS.length;
          return (
            <motion.div
              key={repo.name}
              className={s.repo}
              animate={{ z: -depth * 90, y: -depth * 38, opacity: 1 - depth * 0.3, rotateX: 18, rotateY: -16, filter: `blur(${depth * 1.2}px)` }}
              transition={{ type: 'spring', stiffness: 120, damping: 20 }}
              style={{ zIndex: 10 - depth }}
            >
              <div className={s.repoHead}>
                <Icon name="folder" size={13} />
                <strong>{repo.name}</strong>
                <span className={s.dim}>{repo.lanes.length} worktrees</span>
                <span className={s.repoGh}>
                  <Icon name="globe" size={11} /> GitHub
                </span>
              </div>
              {repo.lanes.map((lane) => (
                <LaneRow key={lane.branch} lane={lane} step={depth === 0 ? step : 0} live={depth === 0} />
              ))}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
