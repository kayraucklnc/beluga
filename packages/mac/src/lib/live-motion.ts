import { type RefObject, useEffect, useRef } from 'react';
import { onWindowActive, windowActive } from './window-active.js';
import { reducedMotion } from './reduced-motion.js';

/**
 * One slow clock for everything that moves while Claude works: the plan's glowing cards and
 * spinners, the dot matrices, the step on now (KLD-40). A CSS animation makes WebKit draw the
 * whole window 60 times a second for as long as it runs, however small it is; this clock writes
 * each live mark's style about 15 times a second instead, so the window draws a quarter as often.
 * Only marks on screen are painted; while you're not looking at Klaud (lib/window-active.ts) the
 * clock stops, and with Reduce Motion every mark rests at its still frame.
 */

/** Paints a mark at `t` ms (a shared clock: marks that look alike move together). `t` null: rest, still. */
export type LivePaint = (t: number | null) => void;

const LIVE_FPS = 15;

const marks = new Map<Element, LivePaint>();
const seen = new Set<Element>();
let timer: ReturnType<typeof setInterval> | undefined;
let watching = false;
let observer: IntersectionObserver | undefined;

function tick(): void {
  const t = performance.now();
  for (const el of seen) marks.get(el)?.(t);
}

/** Runs the clock when there's something on screen to move and someone to see it; otherwise stops it. */
function wake(): void {
  const run = seen.size > 0 && windowActive() && !reducedMotion();
  if (run && !timer) {
    tick();
    timer = setInterval(tick, 1000 / LIVE_FPS);
  } else if (!run && timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (reducedMotion()) for (const el of seen) marks.get(el)?.(null);
}

function watch(): void {
  if (watching) return;
  watching = true;
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', wake);
  // Settings › Appearance › Reduce motion sets data-motion on the document.
  new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  onWindowActive(wake);
}

function observe(el: Element): void {
  if (typeof IntersectionObserver === 'undefined') {
    seen.add(el);
    return;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && marks.has(e.target)) seen.add(e.target);
      else seen.delete(e.target);
    }
    wake();
  });
  observer.observe(el);
}

/** Moves `el` with the live clock until the returned stop is called. */
export function joinLive(el: Element, paint: LivePaint): () => void {
  watch();
  marks.set(el, paint);
  observe(el);
  paint(reducedMotion() ? null : performance.now());
  return () => {
    marks.delete(el);
    seen.delete(el);
    observer?.unobserve(el);
    wake();
  };
}

/** Moves the element in `ref` with the live clock while `on`. `paint` may change between renders. */
export function useLive<T extends Element>(ref: RefObject<T | null>, paint: LivePaint, on = true): void {
  const latest = useRef(paint);
  latest.current = paint;
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    return joinLive(el, (t) => latest.current(t));
  }, [ref, on]);
}

/** 0 → 1 → 0 over `period` ms, eased (a breath). `t` null: fully in. */
export const breath = (t: number | null, period: number): number => (t === null ? 1 : 0.5 + 0.5 * Math.cos(((t % period) / period) * Math.PI * 2));
/** 0 → 360 over `period` ms (a turn). */
export const turn = (t: number | null, period: number): number => (t === null ? 0 : ((t % period) / period) * 360);
