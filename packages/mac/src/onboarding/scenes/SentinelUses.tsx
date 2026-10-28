import { useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon.js';
import { usePrefs } from '../../lib/prefs.js';
import { SLIDES } from '../../sentinel/Showcase.js';
import show from '../../sentinel/showcase.module.css';
import s from './scenes.module.css';

/**
 * Sentinel at work (BLG-362): the same short films Sentinel's own page opens with (Showcase.tsx),
 * so the tour shows what the app will. The night shift, the board and its desktop widgets, a
 * failing test fixed, a pull request read. Each one comes with the sentence that sets it up,
 * as you'd say it to Ask Sentinel. They play one after another; pointing holds one, and the
 * tabs pick. With Reduce Motion each shows its last frame and stays.
 */

/** A tab's name for each film. */
const NAMES: Readonly<Record<string, string>> = {
  sleep: 'Night shift',
  board: 'Your numbers',
  fix: 'Failing tests',
  review: 'Pull requests',
};

export function SentinelUses() {
  const still = (useReducedMotion() ?? false) || usePrefs().reduceMotion;
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const slide = SLIDES[at]!;
  useEffect(() => {
    if (held || still) return;
    const t = setTimeout(() => setAt((at + 1) % SLIDES.length), slide.ms + 1200);
    return () => clearTimeout(t);
  }, [at, held, still]);
  return (
    <div className={s.stage}>
      <div className={s.uses} onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
        <div className={s.usesTabs} role="tablist" aria-label="What sentinels do">
          {SLIDES.map((x, i) => (
            <button key={x.id} type="button" role="tab" aria-selected={i === at} className={s.usesTab} onClick={() => setAt(i)}>
              <Icon name={x.icon} size={12} />
              {NAMES[x.id] ?? x.id}
              {/* The one playing fills as it plays (it holds while you point at it). */}
              {i === at && !still ? <span key={`${x.id}-${at}`} className={s.usesFill} data-held={held || undefined} style={{ animationDuration: `${x.ms + 1200}ms` }} /> : null}
            </button>
          ))}
        </div>
        <div className={s.usesScreen} data-slide={slide.id}>
          {/* Keyed: each film plays from its start when it comes in. */}
          <div key={slide.id} className={show.scene} role="group" aria-roledescription="slide" aria-label={slide.line}>
            {slide.scene()}
          </div>
        </div>
        <div key={slide.id} className={s.usesFoot}>
          <span className={s.usesLine}>
            <Icon name={slide.icon} size={13} />
            {slide.line}
          </span>
          <span className={s.usesSaid}>
            <Icon name="sentinel" size={11} />
            <span>“{slide.prompt}”</span>
          </span>
        </div>
      </div>
    </div>
  );
}
