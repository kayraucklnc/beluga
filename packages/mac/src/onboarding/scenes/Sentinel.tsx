import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ACCESS, ACCESS_INFO, STEP_INFO } from '../../../../../src/core/sentinel/model.js';
import { Icon } from '../../components/Icon.js';
import { usePrefs } from '../../lib/prefs.js';
import { STEP_ICON, TRIGGER_ICON } from '../../sentinel/sentinel-model.js';
import { EASE_OUT, SPRING } from '../fx.js';
import { TOUR_SENTINELS } from '../sentinel-tour.js';
import s from './scenes.module.css';

/**
 * A sentinel, from a sentence (BLG-362): you say when, what and how you hear of it, and it
 * becomes the parts the Sentinel page has: the trigger, the steps in order, the access they
 * need. It starts paused, you turn it on, it runs step by step and leaves a report. Then the
 * next one: a morning brief, a build that fixes itself, a failed payment, a site that went
 * quiet, the numbers. Same parts, a different sentinel each time. The names along the bottom
 * pick one; pointing at it holds it. With Reduce Motion each shows its finished run.
 */

// Beats (ms each): the sentence, the sentinel built (paused), turned on, each step running, the report.
const SAID = 1100;
const BUILT = 1100;
const ON = 650;
const STEP = 620;
const REPORT = 3000;
const beatsOf = (steps: number): readonly number[] => [SAID, BUILT, ON, ...Array.from({ length: steps }, () => STEP), REPORT];

const PARTS = ['when', 'what', 'then'] as const;

export function Sentinel() {
  const still = (useReducedMotion() ?? false) || usePrefs().reduceMotion;
  const [at, setAt] = useState(0);
  const [beat, setBeat] = useState(still ? Number.POSITIVE_INFINITY : 0);
  const [held, setHeld] = useState(false);
  const sentinel = TOUR_SENTINELS[at]!;
  const beats = beatsOf(sentinel.steps.length);
  const last = beats.length - 1;
  useEffect(() => {
    if (still) return setBeat(Number.POSITIVE_INFINITY);
    // Pointing at it holds it on its report; the run itself plays on.
    if (beat >= last && held) return;
    const t = setTimeout(() => {
      if (beat < last) return setBeat(beat + 1);
      setAt((at + 1) % TOUR_SENTINELS.length);
      setBeat(0);
    }, beats[Math.min(beat, last)]);
    return () => clearTimeout(t);
  }, [at, beat, held, still]);
  const pick = (i: number): void => {
    setAt(i);
    setBeat(still ? Number.POSITIVE_INFINITY : 0);
  };

  const built = beat >= 1;
  const on = beat >= 2;
  // The step running now (3 is the first); past them all, the report.
  const running = beat - 3;
  const reported = beat >= last;
  const appear = (delay: number) => (still ? { initial: false as const } : { initial: { opacity: 0, y: 8, filter: 'blur(4px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' }, transition: { duration: 0.45, ease: EASE_OUT, delay } });

  return (
    <div className={s.stage}>
      <div className={s.sentinel} onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
        <div className={s.windowBar}>
          <span className={s.lights}>
            <i />
            <i />
            <i />
          </span>
          <span className={s.sentinelBarName}>
            <Icon name="sentinel" size={12} /> Ask Sentinel
          </span>
          {on && !reported ? (
            <span className={s.live}>
              <span className={s.liveDot} /> Running
            </span>
          ) : null}
        </div>
        <div className={s.sentinelBody}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={sentinel.id} className={s.sentinelRun} initial={still ? false : { opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -18, filter: 'blur(4px)' }} transition={{ duration: 0.35, ease: EASE_OUT }}>
              {/* The sentence: each part takes the color of the piece of the sentinel it becomes. */}
              <div className={s.said}>
                {sentinel.said.map((part, i) => (
                  <motion.span key={part} data-part={PARTS[i]} {...appear(0.1 + i * 0.28)}>
                    {part}
                  </motion.span>
                ))}
              </div>

              <motion.div className={s.sentinelCard} initial={still ? false : { opacity: 0, y: 14, scale: 0.98 }} animate={built ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 14, scale: 0.98 }} transition={SPRING}>
                <div className={s.sentinelHead}>
                  <Icon name={TRIGGER_ICON[sentinel.trigger]} size={13} />
                  <strong>{sentinel.name}</strong>
                  <span className={s.sentinelState} data-on={on || undefined}>
                    {on ? 'Watching' : 'Paused'}
                  </span>
                  <span className={s.toggle} data-on={on || undefined} role="img" aria-label={on ? 'Turned on' : 'Starts paused'}>
                    <i />
                  </span>
                </div>
                <div className={s.sentinelRow} data-part="when">
                  <span className={s.sentinelLabel}>When</span>
                  <Icon name={TRIGGER_ICON[sentinel.trigger]} size={12} />
                  <span>{sentinel.when}</span>
                </div>
                {sentinel.steps.map((st, i) => {
                  const state = running > i || reported ? 'done' : running === i ? 'running' : 'waiting';
                  return (
                    <div key={st.kind + i} className={s.sentinelRow} data-part={st.kind === 'claude' || st.kind === 'script' || st.kind === 'measure' ? 'what' : 'then'} data-state={state}>
                      <span className={s.sentinelLabel}>{i === 0 ? 'Then' : ''}</span>
                      <span className={s.stepNum}>{i + 1}</span>
                      <Icon name={STEP_ICON[st.kind]} size={12} />
                      <span className={s.stepKind}>{STEP_INFO[st.kind].label}</span>
                      <span className={s.stepDetail}>{st.detail}</span>
                      <span className={s.stepState}>{state === 'done' ? <Icon name="check" size={12} className={s.done} /> : state === 'running' ? <Icon name="refresh" size={12} className={s.spin} /> : null}</span>
                    </div>
                  );
                })}
                <div className={s.sentinelAccess}>
                  <span className={s.accessPick} role="img" aria-label={`${ACCESS_INFO[sentinel.access].label} access`}>
                    {ACCESS.map((a) => (
                      <span key={a} data-on={a === sentinel.access || undefined}>
                        {ACCESS_INFO[a].label}
                      </span>
                    ))}
                  </span>
                  <span className={s.dim}>{ACCESS_INFO[sentinel.access].sentence}</span>
                </div>
              </motion.div>

              <AnimatePresence>
                {reported ? (
                  <motion.div key="report" className={s.report} initial={still ? false : { opacity: 0, y: 12, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SPRING}>
                    <span className={s.reportIcon}>
                      <Icon name="bell" size={12} />
                    </span>
                    <span className={s.reportText}>
                      <strong>{sentinel.report.title}</strong>
                      <span>{sentinel.report.line}</span>
                    </span>
                    <span className={s.dim}>Report</span>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className={s.sentinelPick} role="tablist" aria-label="Sentinels">
          {TOUR_SENTINELS.map((x, i) => (
            <button key={x.id} type="button" role="tab" aria-selected={i === at} className={s.sentinelChip} onClick={() => pick(i)}>
              <Icon name={TRIGGER_ICON[x.trigger]} size={11} />
              {x.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
