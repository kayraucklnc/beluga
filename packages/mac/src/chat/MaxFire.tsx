import { type RefObject, useEffect, useRef } from 'react';
import { MaxFire as Fire, caretPoint } from './max-fire.js';
import s from './max.module.css';

/** How far the canvas reaches past the box: room above for the flames, a little round the sides. */
const PAD = { top: 40, side: 22, bottom: 14 } as const;

/**
 * Max effort: the box is on fire, and every character you type throws a little confetti from the
 * caret. With reduced motion only the ember rim stays (see max.module.css).
 */
export function MaxFire({ box, input }: { box: RefObject<HTMLDivElement | null>; input: RefObject<HTMLTextAreaElement | null> }) {
  const behind = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const host = box.current;
    const field = input.current;
    if (!behind.current || !over.current || !host || !field || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const fire = new Fire(behind.current, over.current);
    const fit = (): void => {
      const { width, height } = host.getBoundingClientRect();
      fire.resize(width + PAD.side * 2, height + PAD.top + PAD.bottom, { x: PAD.side, y: PAD.top, w: width, h: height }, isDark(getComputedStyle(host).backgroundColor));
    };
    fit();
    const sizes = new ResizeObserver(fit);
    sizes.observe(host);
    const typed = (e: Event): void => {
      const kind = (e as InputEvent).inputType ?? '';
      if (!kind.startsWith('insert')) return;
      const at = caretPoint(field);
      const from = field.getBoundingClientRect();
      const origin = host.getBoundingClientRect();
      fire.burst(from.left - origin.left + at.x + PAD.side, from.top - origin.top + at.y + PAD.top, kind === 'insertFromPaste' ? 24 : 9);
    };
    const focus = (): void => fire.focus(host.contains(document.activeElement));
    const shown = (): void => (document.hidden ? fire.stop() : fire.start());
    field.addEventListener('input', typed);
    host.addEventListener('focusin', focus);
    host.addEventListener('focusout', focus);
    document.addEventListener('visibilitychange', shown);
    focus();
    shown();
    return () => {
      fire.stop();
      sizes.disconnect();
      field.removeEventListener('input', typed);
      host.removeEventListener('focusin', focus);
      host.removeEventListener('focusout', focus);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [box, input]);
  const place = { top: -PAD.top, left: -PAD.side, width: `calc(100% + ${PAD.side * 2}px)`, height: `calc(100% + ${PAD.top + PAD.bottom}px)` };
  return (
    <>
      <canvas ref={behind} className={s.flames} style={place} aria-hidden />
      <canvas ref={over} className={s.confetti} style={place} aria-hidden />
    </>
  );
}

/** A dark box (its background's lightness, from "rgb(r, g, b)"). */
function isDark(color: string): boolean {
  const [r = 255, g = 255, b = 255] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
