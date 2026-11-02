import { motion } from 'motion/react';
import { useRef, useState } from 'react';
import type { TerminalFound } from '@beluga/terminal/import/look.js';
import { cx } from '../components/ui.js';
import { type Before, Swatches, TermPreview, before, importable, useTerminals, withImport } from '../dialogs/TerminalImport.js';
import { getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { colorsFor, importSummary } from '../lib/terminal-import-model.js';
import { hasFont } from '../lib/terminal-look.js';
import { Rise, SPRING, Words } from './fx.js';
import s from './onboarding.module.css';

const KEEP = 'beluga';

/**
 * "Coming from another terminal?" (BLG-212): the terminals found on this Mac, each drawn in its
 * own colours and font, and Beluga's own. Picking one brings its look into Beluga's terminal at
 * once (as the look step does); Beluga's puts back what was there. Continue without picking
 * changes nothing; Settings › Terminal › Import from… has it later.
 */
export function TerminalStep() {
  const prefs = usePrefs();
  const { found } = useTerminals();
  const choices = importable(found);
  // What the terminal settings were when the step opened: each pick goes over these, and Beluga's puts them back.
  const orig = useRef<Before>(before(getPrefs()));
  const [chose, setPicked] = useState<string>();
  // Before you pick: the one you brought in before (a replay of the welcome), or Beluga's.
  const picked = chose ?? choices.find((f) => f.name === prefs.termTheme?.from)?.app ?? KEEP;
  const base = { ...prefs, ...orig.current };
  const pick = (f: TerminalFound | undefined): void => {
    setPicked(f?.app ?? KEEP);
    setPrefs(f ? withImport({ ...getPrefs(), ...orig.current }, f) : { ...orig.current, termTheme: null });
  };
  const chosen = choices.find((f) => f.app === picked);
  const options: Array<{ key: string; label: string; found?: TerminalFound }> = [...choices.map((f) => ({ key: f.app, label: f.name, found: f })), { key: KEEP, label: 'Beluga’s Own' }];
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Coming from another terminal?" />
      </h2>
      <Rise delay={0.2} className={s.body}>
        {found === undefined
          ? 'Looking for the terminals on this Mac…'
          : choices.length
            ? 'Bring its colours, font and cursor into Beluga’s terminal. It changes as you pick, and Settings › Terminal has it later.'
            : 'No other terminal here has settings to bring, so Beluga’s terminal keeps its own look. Settings › Terminal › Import from… can bring one in later.'}
      </Rise>
      {choices.length ? (
        <>
          <div className={cx(s.looks, s.terms)} role="radiogroup" aria-label="Terminal look">
            {options.map((o, i) => {
              const on = picked === o.key;
              return (
                <motion.button
                  key={o.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={cx(s.lookCard, on && s.lookOn)}
                  onClick={() => pick(o.found)}
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  whileHover={{ y: -3 }}
                  transition={{ ...SPRING, delay: 0.25 + i * 0.07 }}
                >
                  <span className={s.termMini}>
                    <TermPreview prefs={o.found ? withImport(base, o.found) : { ...base, termTheme: null }} compact />
                    {o.found?.look?.theme ? (
                      <span className={s.termSw}>
                        <Swatches colors={colorsFor(o.found.look.theme, document.documentElement.dataset.theme === 'dark')!} size={8} />
                      </span>
                    ) : null}
                  </span>
                  <span className={s.lookLabel}>
                    <span className={s.radio}>{on ? <motion.span layoutId="term-dot" className={s.radioDot} transition={SPRING} /> : null}</span>
                    {o.label}
                  </span>
                </motion.button>
              );
            })}
          </div>
          <Rise delay={0.5} className={s.termBrings}>
            {chosen?.look ? importSummary(chosen.look, hasFont).join(' · ') : 'Beluga’s colours, following light and dark.'}
          </Rise>
        </>
      ) : null}
    </div>
  );
}
