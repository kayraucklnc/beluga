import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { anchorScroll, clampZoom, pinchStep } from './pinch-model.js';

/**
 * Pinch to zoom on a trackpad (two fingers apart to zoom in, together to zoom out) over a picture
 * or a PDF. The Mac's web view sends pinches as gesture events (Safari's `gesturechange`, with a
 * scale); Chromium sends them as Ctrl+wheel. Both are taken here, the window itself never zooms,
 * and the point under your fingers stays where it is.
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
}

/**
 * `zoom` is the size shown now (a number, even while "fit"); `onZoom` sets a new one. The
 * component calls nothing else: the place is kept after its next render.
 */
export function usePinchZoom(target: RefObject<HTMLElement | null>, zoom: number, onZoom: (next: number) => void, opts: PinchOptions = {}): void {
  const live = useRef({ zoom, onZoom, opts });
  live.current = { zoom, onZoom, opts };
  // Where to scroll once the new size is on screen.
  const pending = useRef<{ box: HTMLElement; x: number; y: number; ratio: number } | undefined>(undefined);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let start = 1;
    const zoomTo = (next: number, clientX: number, clientY: number): void => {
      const { zoom: now, onZoom: set, opts: o } = live.current;
      const to = clampZoom(next, o.min, o.max);
      if (Math.abs(to - now) < 0.0005) return;
      const box = scroller(el);
      if (box) {
        const r = box.getBoundingClientRect();
        pending.current = { box, x: clientX - r.left, y: clientY - r.top, ratio: to / now };
      }
      set(to);
    };
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return; // an ordinary scroll
      e.preventDefault();
      zoomTo(pinchStep(live.current.zoom, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY), e.clientX, e.clientY);
    };
    const onStart = (e: Event): void => {
      e.preventDefault();
      start = live.current.zoom;
    };
    const onChange = (e: Event): void => {
      e.preventDefault();
      const g = e as GestureEvent;
      zoomTo(start * g.scale, g.clientX, g.clientY);
    };
    const stop = (e: Event): void => e.preventDefault();
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onStart, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gesturechange', onChange, { passive: false } as AddEventListenerOptions);
    el.addEventListener('gestureend', stop, { passive: false } as AddEventListenerOptions);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onStart);
      el.removeEventListener('gesturechange', onChange);
      el.removeEventListener('gestureend', stop);
    };
  }, [target.current]);

  // The new size is laid out: scroll so the point under the fingers is where it was.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = undefined;
    p.box.scrollLeft = anchorScroll(p.box.scrollLeft, p.x, p.ratio);
    p.box.scrollTop = anchorScroll(p.box.scrollTop, p.y, p.ratio);
  }, [zoom]);
}
