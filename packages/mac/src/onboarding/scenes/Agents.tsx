import { AnimatePresence, motion } from 'motion/react';
import { Icon, type IconName } from '../../components/Icon.js';
import { SPRING } from '../fx.js';
import { useBeats } from './use-beats.js';
import s from './scenes.module.css';

/**
 * Watch every agent, steer any of them: a conversation's steps arrive as Claude works, its
 * sub-agents run beside it, a screenshot one of them took lands in view, and then you type a
 * word to change course mid-run and Claude takes it.
 */

interface Step {
  readonly icon: IconName;
  readonly text: string;
  readonly code?: string;
}

const STEPS: readonly Step[] = [
  { icon: 'file', text: 'Read', code: 'src/auth/login.ts' },
  { icon: 'search', text: 'Searched for', code: 'rateLimit(' },
  { icon: 'pencil', text: 'Edited', code: 'login.ts  +24 −3' },
  { icon: 'terminal', text: 'Ran', code: 'npm test' },
];

const AGENTS: ReadonlyArray<{ name: string; doing: string }> = [
  { name: 'explorer', doing: 'Mapping the auth flow' },
  { name: 'tests', doing: 'Writing 6 tests' },
  { name: 'browser', doing: 'Checking the login page' },
];

// Beats: steps arrive one by one, the screenshot lands, you steer, Claude answers.
const BEATS = [700, 700, 700, 900, 1500, 1700, 2600] as const;

export function Agents() {
  const beat = useBeats(BEATS, 6);
  const shown = Math.min(STEPS.length, beat + 1);
  const shot = beat >= 4;
  const steered = beat >= 5;
  const answered = beat >= 6;
  return (
    <div className={s.stage} style={{ perspective: 1600 }}>
      <motion.div className={s.agents} initial={{ rotateX: 8, rotateY: 12 }} animate={{ rotateX: 8, rotateY: 12 }}>
        <div className={s.window}>
          <div className={s.windowBar}>
            <span className={s.lights}>
              <i />
              <i />
              <i />
            </span>
            <span className={s.mono}>api · feat/rate-limits</span>
            <span className={s.live}>
              <span className={s.liveDot} /> Live
            </span>
          </div>
          <div className={s.chat}>
            <div className={s.ask}>Add rate limiting to login, with tests</div>
            <div className={s.steps}>
              <AnimatePresence initial={false}>
                {STEPS.slice(0, shown).map((st, i) => (
                  <motion.div key={st.text} className={s.step} initial={{ opacity: 0, x: -10, filter: 'blur(4px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }} transition={SPRING}>
                    <Icon name={i === shown - 1 && !steered ? 'refresh' : 'check'} size={12} className={i === shown - 1 && !steered ? s.spin : s.done} />
                    <span>{st.text}</span>
                    {st.code ? <code>{st.code}</code> : null}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            <AnimatePresence>
              {steered ? (
                <motion.div key="steer" className={s.steer} initial={{ opacity: 0, y: 14, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={SPRING}>
                  <span className={s.steerTag}>You, mid-run</span>
                  Use the limiter we already have in <code>lib/limits</code>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <AnimatePresence>
              {answered ? (
                <motion.div key="answer" className={s.answer} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ ...SPRING, delay: 0.15 }}>
                  <Icon name="claude" size={13} className={s.claudeMark} /> Got it, switching to <code>lib/limits</code>.
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className={s.side}>
          {AGENTS.map((a, i) => (
            <motion.div key={a.name} className={s.agent} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ ...SPRING, delay: 0.25 + i * 0.12 }}>
              <span className={s.agentDot} style={{ animationDelay: `${i * 0.4}s` }} />
              <div>
                <strong className={s.mono}>{a.name}</strong>
                <span className={s.dim}>{a.doing}</span>
              </div>
            </motion.div>
          ))}
          <AnimatePresence>
            {shot ? (
              <motion.div key="shot" className={s.shot} initial={{ opacity: 0, y: 30, rotate: -6, scale: 0.8 }} animate={{ opacity: 1, y: 0, rotate: -2, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ type: 'spring', stiffness: 200, damping: 18 }}>
                <div className={s.shotPage}>
                  <span className={s.shotLine} style={{ width: '46%' }} />
                  <span className={s.shotField} />
                  <span className={s.shotField} />
                  <span className={s.shotButton} />
                  <span className={s.shotToast}>Too many tries. Wait 30 s.</span>
                </div>
                <span className={s.shotCaption}>
                  <Icon name="image" size={11} /> browser took a screenshot
                </span>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
