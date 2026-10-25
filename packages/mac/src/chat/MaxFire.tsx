import { type RefObject, useEffect, useRef } from 'react';
import { usePrefs } from '../lib/prefs.js';
import { type FireLook, paletteOf, reachOf } from './fire-look.js';
import { type FireTune, MaxFire as Fire, caretPoint } from './max-fire.js';
import s from './max.module.css';

/** Room round the box for the fire (above it, as tall as it can burn: never cut off). */
const SIDE = 40;
const BOTTOM = 16;
const TOP = reachOf({ height: 1, thickness: 1 });

const tuneOf = (look: FireLook): FireTune => ({ style: look.style, show: look.show, fuel: look.fuel, height: look.height, thickness: look.thickness, wildness: look.wildness, colors: paletteOf(look).colors, temper: look.temper });

/**
 * Max effort: the box is on fire; typing throws confetti from the caret, and deleting pops what
 * you took out into pixels. How it all looks is Settings › Max Fire (`look` overrides it, for that
 * page's preview). With reduced motion only the rim stays (see max.module.css).
 */
export function MaxFire({ box, input, look: given }: { box: RefObject<HTMLDivElement | null>; input: RefObject<HTMLTextAreaElement | null>; look?: FireLook }) {
  const behind = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const fire = useRef<Fire | undefined>(undefined);
  const prefs = usePrefs();
  const look = given ?? prefs.maxFire;
  // Room for the tallest fire, always: a taller look never resizes (and restarts) it.
  const top = TOP;
  const now = useRef({ look, top });
  now.current = { look, top };
  useEffect(() => fire.current?.setTune(tuneOf(look)), [look]);
  useEffect(() => {
    const host = box.current;
    const field = input.current;
    if (!behind.current || !over.current || !host || !field || prefs.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const f = new Fire(behind.current, over.current);
    f.setTune(tuneOf(now.current.look));
    fire.current = f;
    const fit = (): void => {
      const { width, height } = host.getBoundingClientRect();
      f.resize(width + SIDE * 2, height + now.current.top + BOTTOM, { x: SIDE, y: now.current.top, w: width, h: height, r: parseFloat(getComputedStyle(host).borderTopLeftRadius) || 12 });
    };
    fit();
    const sizes = new ResizeObserver(fit);
    sizes.observe(host);
    /** The caret, in the canvas. */
    const caret = (): { x: number; y: number } => {
      const at = caretPoint(field);
      const from = field.getBoundingClientRect();
      const origin = host.getBoundingClientRect();
      return { x: from.left - origin.left + at.x + SIDE, y: from.top - origin.top + at.y + now.current.top };
    };
    let length = field.value.length;
    const typed = (e: Event): void => {
      const kind = (e as InputEvent).inputType ?? '';
      const gone = Math.max(0, length - field.value.length);
      length = field.value.length;
      const { typing, popDelete } = now.current.look;
      if (kind.startsWith('insert')) {
        f.stoke();
        if (typing !== 'off') f.burst(caret(), kind === 'insertFromPaste' ? 24 : typing === 'pixels' ? 7 : 9, typing === 'pixels');
      } else if (kind.startsWith('delete') && popDelete && gone) {
        f.pop(caret(), gone);
      }
    };
    const focus = (): void => f.focus(host.contains(document.activeElement));
    const shown = (): void => (document.hidden ? f.stop() : f.start());
    field.addEventListener('input', typed);
    host.addEventListener('focusin', focus);
    host.addEventListener('focusout', focus);
    document.addEventListener('visibilitychange', shown);
    focus();
    shown();
    return () => {
      f.stop();
      fire.current = undefined;
      sizes.disconnect();
      field.removeEventListener('input', typed);
      host.removeEventListener('focusin', focus);
      host.removeEventListener('focusout', focus);
      document.removeEventListener('visibilitychange', shown);
    };
    // A taller fire needs a taller canvas: start again at the new size.
  }, [box, input, prefs.reduceMotion, top]);
  const place = { top: -top, left: -SIDE, width: `calc(100% + ${SIDE * 2}px)`, height: `calc(100% + ${top + BOTTOM}px)` };
  return (
    <>
      <canvas ref={behind} className={s.flames} style={place} aria-hidden />
      <canvas ref={over} className={s.confetti} style={place} aria-hidden />
    </>
  );
}
