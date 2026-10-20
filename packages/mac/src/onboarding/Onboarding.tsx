import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { APP_VERSION } from '../lib/boot.js';
import { useApp, useKlaud } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { Backdrop } from './Backdrop.js';
import { EASE_OUT, SPRING } from './fx.js';
import { SHOW_WELCOME, STEPS, type Step, afterTour, inTour, saveMark, shouldShow, stepBy, stepIndex, tourPlace } from './onboarding-model.js';
import { Look, Setup } from './SetupSteps.js';
import { Hello, Ready, Tour } from './Steps.js';
import s from './onboarding.module.css';

/** How lit the backdrop is on each step: bright for the welcome and the end, calm behind settings. */
const ENERGY: Record<Step, number> = { hello: 1, parallel: 0.75, agents: 0.75, friends: 0.75, earnings: 0.75, archive: 0.75, look: 0.5, setup: 0.4, ready: 1 };

const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Whether it's showing, and the way to show it again on purpose. */
export function useOnboarding(): { open: boolean; close: (how: 'finished' | 'skipped') => void } {
  const [open, setOpen] = useState(() => shouldShow(localStorage, window.location.search));
  useEffect(() => {
    // The first time only: quit halfway and it's back next launch. Seeing it again from Help
    // leaves the mark as it was, so a replay you leave never brings it back on its own.
    if (open) saveMark(localStorage, APP_VERSION, 'started');
  }, []);
  useEffect(() => {
    const show = (): void => setOpen(true);
    document.addEventListener(SHOW_WELCOME, show);
    return () => document.removeEventListener(SHOW_WELCOME, show);
  }, []);
  return {
    open,
    close: (how) => {
      saveMark(localStorage, APP_VERSION, how);
      setOpen(false);
    },
  };
}

/** The dots under every step: where you are, the tour's part grouped, each one a way back. */
function Progress({ step, go }: { readonly step: Step; readonly go: (to: Step) => void }) {
  const at = stepIndex(step);
  return (
    <div className={s.progress} role="group" aria-label="Steps">
      {STEPS.map((st, i) => (
        <button key={st} type="button" aria-current={st === step ? 'step' : undefined} aria-label={`Step ${i + 1} of ${STEPS.length}`} className={s.progressDot} data-past={i < at} disabled={i > at} onClick={() => go(st)}>
          {st === step ? <motion.span layoutId="progress-on" className={s.progressOn} transition={SPRING} /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The first time Klaud opens: a welcome, a five-part tour of what it does, a look and a few
 * settings, then the app. A full window of its own over the app (which is already there
 * underneath, so finishing simply lifts this away).
 */
export function Onboarding({ onClose }: { readonly onClose: (how: 'finished' | 'skipped') => void }) {
  const { ui } = useKlaud();
  const prefs = usePrefs();
  const projects = useApp((st) => st.projects.filter((p) => p.root).length);
  const still = (useReducedMotion() ?? false) || prefs.reduceMotion;
  const [step, setStep] = useState<Step>('hello');
  const [dir, setDir] = useState(1);
  const [leaving, setLeaving] = useState<'finished' | 'skipped'>();
  const theme = prefs.appearance === 'system' ? (systemDark() ? 'dark' : 'light') : prefs.appearance;

  const go = (to: Step): void => {
    setDir(stepIndex(to) >= stepIndex(step) ? 1 : -1);
    setStep(to);
  };
  const next = (): void => (step === 'ready' ? finish('finished') : go(stepBy(step, 1)));
  const back = (): void => go(stepBy(step, -1));
  const exit = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(exit.current), []);
  const finish = (how: 'finished' | 'skipped', then?: () => void): void => {
    if (leaving) return;
    setLeaving(how);
    // The window lifts away, then the app underneath is yours (and the next sheet opens on it).
    exit.current = setTimeout(
      () => {
        onClose(how);
        then?.();
      },
      still ? 0 : 650,
    );
  };

  // Return goes on, ⌘[ and ⌘] go back and forth; the arrow keys too, when you're not in a field
  // or a choice. Listened for first (capture), so the app's own keys underneath (⌘K, ⌘N…) wait.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey) e.stopPropagation();
      if (leaving) return;
      const field = e.target instanceof HTMLElement && e.target.closest('input, textarea, [role="combobox"], [role="listbox"], [role="radiogroup"], [role="switch"]');
      const onButton = e.target instanceof HTMLButtonElement && !e.target.closest('[role="radiogroup"]');
      if (e.key === 'Enter' && !e.metaKey && !onButton && !(field && e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        next();
      } else if ((e.metaKey && e.key === ']') || (!field && e.key === 'ArrowRight')) {
        e.preventDefault();
        if (step !== 'ready') next();
      } else if ((e.metaKey && e.key === '[') || (!field && e.key === 'ArrowLeft')) {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const place = tourPlace(step);
  const showNav = step !== 'hello' && step !== 'ready';
  return (
    <MotionConfig reducedMotion={still ? 'always' : 'never'}>
      <motion.div
        className={s.overlay}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to Klaud"
        initial={{ opacity: 0 }}
        animate={leaving ? { opacity: 0, scale: 1.04, filter: 'blur(14px)' } : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
        transition={{ duration: leaving ? 0.6 : 0.8, ease: EASE_OUT }}
      >
        <div className={s.backdrop}>
          <Backdrop theme={theme} energy={ENERGY[step]} still={still} />
        </div>
        <div className={s.titlebar} data-tauri-drag-region />
        {step !== 'ready' ? (
          <button type="button" className={s.skip} onClick={() => finish('skipped')}>
            Skip Setup
          </button>
        ) : null}

        <main className={s.content}>
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <motion.section
              key={step}
              // Focus comes into each step (unless a button in it took it), so Tab stays in here.
              ref={(el) => void (el && !el.contains(document.activeElement) && el.focus({ preventScroll: true }))}
              tabIndex={-1}
              className={s.page}
              custom={dir}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: d * 48, filter: 'blur(10px)' }),
                center: { opacity: 1, x: 0, filter: 'blur(0px)' },
                exit: (d: number) => ({ opacity: 0, x: d * -48, filter: 'blur(10px)' }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.45, ease: EASE_OUT }}
            >
              {step === 'hello' ? <Hello onStart={next} /> : null}
              {inTour(step) ? <Tour step={step} /> : null}
              {step === 'look' ? <Look /> : null}
              {step === 'setup' ? <Setup /> : null}
              {step === 'ready' ? <Ready projects={projects} onOpen={() => finish('finished')} onAddProject={() => finish('finished', () => ui.patch({ addProject: true }))} /> : null}
            </motion.section>
          </AnimatePresence>
        </main>

        <AnimatePresence>
          {showNav ? (
            <motion.footer className={s.footer} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.4, ease: EASE_OUT }}>
              <button type="button" className={s.navBack} onClick={back} aria-label="Back">
                <Icon name="back" size={14} />
              </button>
              <Progress step={step} go={go} />
              <div className={s.navRight}>
                {place ? (
                  <button type="button" className={s.navSkipTour} onClick={() => go(afterTour())}>
                    Skip Tour
                  </button>
                ) : null}
                <motion.button type="button" className={s.navNext} onClick={next} whileTap={{ scale: 0.96 }}>
                  {step === 'setup' ? 'Finish' : 'Continue'}
                  <Icon name="arrowRight" size={13} />
                </motion.button>
              </div>
            </motion.footer>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </MotionConfig>
  );
}
