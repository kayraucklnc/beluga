import { type RefObject, useEffect, useRef } from 'react';
import { usePrefs } from '../lib/prefs.js';
import { type FireLook, paletteOf, reachOf } from './fire-look.js';
import { type FireTune, MaxFire as Fire, caretPoint } from './max-fire.js';
import s from './max.module.css';

/** Room round the box for the fire (above it, as tall as it can burn: never cut off). */
const SIDE = 40;
const BOTTOM = 40;
const TOP = reachOf({ height: 1, thickness: 1 });

const tuneOf = (look: FireLook): FireTune => ({ style: look.style, show: look.show, fuel: look.fuel, height: look.height, thickness: look.thickness, wildness: look.wildness, colors: paletteOf(look).colors, temper: look.temper, catchAfter: look.catchAfter, outAfter: look.outAfter });

/**
 * Max effort: the box is on fire; typing throws confetti from the caret, and deleting pops what
 * you took out into pixels. How it all looks is Settings › Max Fire (`look` overrides it, for that
 * page's preview). With reduced motion only the rim stays (see max.module.css).
 */
export function MaxFire({ box, input, look: given }: { box: RefObject<HTMLElement | null>; input: RefObject<HTMLTextAreaElement | null>; look?: FireLook }) {
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
    f.onBurn = (amount) => host.style.setProperty('--burn', amount.toFixed(3));
    const fit = (): void => {
      const rect = host.getBoundingClientRect();
      const { width, height } = rect;
      const top = now.current.top;
      // What of the canvas can be seen: the window, cut down by every container that clips.
      let [x0, y0, x1, y1] = [0, 0, window.innerWidth, window.innerHeight];
      for (let el = host.parentElement; el && el !== document.body; el = el.parentElement) {
        const css = getComputedStyle(el);
        if (css.overflowX === 'visible' && css.overflowY === 'visible') continue;
        const r = el.getBoundingClientRect();
        [x0, y0, x1, y1] = [Math.max(x0, r.left), Math.max(y0, r.top), Math.min(x1, r.right), Math.min(y1, r.bottom)];
      }
      const ox = rect.left - SIDE;
      const oy = rect.top - top;
      const clip = { x0: x0 - ox, y0: y0 - oy, x1: x1 - ox, y1: y1 - oy };
      f.resize(width + SIDE * 2, height + top + BOTTOM, { x: SIDE, y: top, w: width, h: height, r: parseFloat(getComputedStyle(host).borderTopLeftRadius) || 12, clip });
    };
    fit();
    const sizes = new ResizeObserver(fit);
    sizes.observe(host);
    // The space around it changes with the window and the panels (not the box itself).
    window.addEventListener('resize', fit);
    const around = host.closest('main') ?? host.parentElement;
    if (around) sizes.observe(around);
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
        f.stoke(caret());
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
      window.removeEventListener('resize', fit);
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
