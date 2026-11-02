import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { anchorScroll, clampZoom, pinchStep, settleScroll } from './pinch-model.js';

/**
 * Pinch to zoom on a trackpad (two fingers apart to zoom in, together to zoom out) over a picture
 * or a PDF. The Mac's web view sends pinches as gesture events (Safari's `gesturechange`, with a
 * scale); Chromium sends them as Ctrl+wheel. Both are taken here, the window itself never zooms,
 * and the point under your fingers stays where it is.
 *
 * A trackpad sends more pinch events than the screen draws frames, and each new size used to be a
 * React render and a layout of the whole page (the picture's width and height, the checkered
 * stage around it, the scroll). Now events only add up; the size is handed on at most once a
 * frame. Given a `live` element (the picture), it's even cheaper: while your fingers move, that
 * element is just scaled with a transform (no layout at all), and the new size is laid out once,
 * when they stop.
 */

interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

/** The nearest box around `el` that scrolls (where the zoomed content moves). */
function scroller(el: HTMLElement): HTMLElement | undefined {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(at);
    if (/(auto|scroll)/.test(overflowX + overflowY)) return at;
  }
  return undefined;
}

export interface PinchOptions {
  readonly min?: number;
  readonly max?: number;
  /**
   * The element to scale with a transform while a pinch goes on (the picture). The new zoom is
   * then handed to `onZoom` only once the pinch rests, and the page is scrolled so the point under
   * your fingers stays put.
   */
  readonly live?: RefObject<HTMLElement | null>;
}

/** A pinch rests after this long without an event (a trackpad's gestureend can't be counted on in Chromium). */
const REST_MS = 140;

/**
 * `zoom` is the size shown now (a number, even while "fit"); `onZoom` sets a new one. The
 * component calls nothing else: the place is kept after its next render.
 */
export function usePinchZoom(target: RefObject<HTMLElement | null>, zoom: number, onZoom: (next: number) => void, opts: PinchOptions = {}): void {
  const live = useRef({ zoom, onZoom, opts });
  live.current = { zoom, onZoom, opts };
  // Where to scroll once the new size is on screen.
  const pending = useRef<{ box?: HTMLElement; x?: number; y?: number; ratio: number; fx?: number; fy?: number; clientX: number; clientY: number } | undefined>(undefined);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let start = 1;
    // The pinch under way: the zoom it started from, where it's going, and its anchor.
    let pinch: { from: number; to: number; clientX: number; clientY: number; fx: number; fy: number } | undefined;
    let frame = 0;
    let rest = 0;

    const shown = (): number => pinch?.to ?? live.current.zoom;
    const picture = (): HTMLElement | null | undefined => live.current.opts.live?.current;

    /** Lays the new size out (once), and keeps the point under the fingers where it was. */
    const commit = (to: number, clientX: number, clientY: number, anchor?: { fx: number; fy: number }): boolean => {
      const { zoom: now, onZoom: set } = live.current;
      if (Math.abs(to - now) < 0.0005) return false;
      const box = scroller(el);
      const r = box?.getBoundingClientRect();
      pending.current = { ...(box && r ? { box, x: clientX - r.left, y: clientY - r.top } : {}), ratio: to / now, clientX, clientY, ...(anchor ?? {}) };
      set(to);
      return true;
    };

    const draw = (): void => {
      frame = 0;
      const p = pinch;
      const pic = picture();
      if (!p) return;
      if (pic) {
        pic.style.transform = `scale(${p.to / p.from})`;
        return;
      }
      // Nothing to scale on its own (a PDF's pages): the new size, once this frame.
      pinch = undefined;
      commit(p.to, p.clientX, p.clientY);
    };

    const settle = (): void => {
      window.clearTimeout(rest);
      const p = pinch;
      pinch = undefined;
      const pic = picture();
      if (!p) return;
      cancelAnimationFrame(frame);
      frame = 0;
      // Laid out at its new size, and only then let go of the transform (in the same frame: no jump).
      if (!commit(p.to, p.clientX, p.clientY, { fx: p.fx, fy: p.fy }) && pic) unscale(pic);
    };

    const zoomTo = (next: number, clientX: number, clientY: number): void => {
      const o = live.current.opts;
      const to = clampZoom(next, o.min, o.max);
      if (Math.abs(to - shown()) < 0.0005) return;
      if (!pinch) {
        const pic = picture();
        let fx = 0.5;
        let fy = 0.5;
        if (pic) {
          // The point of the picture under the fingers, kept still while it's scaled.
          const r = pic.getBoundingClientRect();
          fx = r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0.5;
          fy = r.height ? Math.min(1, Math.max(0, (clientY - r.top) / r.height)) : 0.5;
          pic.style.transformOrigin = `${fx * 100}% ${fy * 100}%`;
          pic.style.willChange = 'transform';
        }
        pinch = { from: live.current.zoom, to, clientX, clientY, fx, fy };
      } else pinch = { ...pinch, to };
      if (!frame) frame = requestAnimationFrame(draw);
      if (picture()) {
        window.clearTimeout(rest);
        rest = window.setTimeout(settle, REST_MS);
      }
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return; // an ordinary scroll
      e.preventDefault();
      zoomTo(pinchStep(shown(), e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY), e.clientX, e.clientY);
    };
    const onStart = (e: Event): void => {
      e.preventDefault();
      start = shown();
    };
    const onChange = (e: Event): void => {
      e.preventDefault();
      const g = e as GestureEvent;
      zoomTo(start * g.scale, g.clientX, g.clientY);
    };
    const onEnd = (e: Event): void => {
      e.preventDefault();
      if (pinch && picture()) settle();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onStart, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gesturechange', onChange, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gestureend', onEnd, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onStart);
      el.removeEventListener('gesturechange', onChange);
      el.removeEventListener('gestureend', onEnd);
      cancelAnimationFrame(frame);
      window.clearTimeout(rest);
    };
  }, [target.current]);

  // The new size is laid out: scroll so the point under the fingers is where it was.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = undefined;
    const pic = live.current.opts.live?.current;
    if (pic && p.fx !== undefined && p.fy !== undefined) {
      unscale(pic);
      if (!p.box) return;
      // Measured: where that point of the picture is now, moved back under the fingers.
      const r = pic.getBoundingClientRect();
      p.box.scrollLeft = settleScroll(p.box.scrollLeft, r.left + p.fx * r.width, p.clientX);
      p.box.scrollTop = settleScroll(p.box.scrollTop, r.top + p.fy * r.height, p.clientY);
      return;
    }
    if (!p.box || p.x === undefined || p.y === undefined) return;
    p.box.scrollLeft = anchorScroll(p.box.scrollLeft, p.x, p.ratio);
    p.box.scrollTop = anchorScroll(p.box.scrollTop, p.y, p.ratio);
  }, [zoom]);
}

/** Back to its laid-out self (the pinch's transform let go). */
function unscale(pic: HTMLElement): void {
  pic.style.transform = '';
  pic.style.transformOrigin = '';
  pic.style.willChange = '';
}
