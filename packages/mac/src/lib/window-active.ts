import { useEffect, useState, useSyncExternalStore } from 'react';
import { inApp } from './boot.js';

/**
 * Whether you're looking at Klaud's window: it's in front (focused) and not hidden, minimized or
 * covered. While it isn't, Klaud stays cool (KLD-40): `html[data-window='idle']` pauses every CSS
 * animation (base.css), the dot matrices and once-a-second clocks stop, and live polling waits.
 * Live states still arrive and render as they happen; only motion and ticking rest. Back in
 * front, everything resumes at once and pollers fetch right away.
 */

const listeners = new Set<() => void>();
let active = true;
let started = false;

const look = (): boolean => document.visibilityState === 'visible' && document.hasFocus();

function set(next: boolean): void {
  if (next === active) return;
  active = next;
  document.documentElement.dataset.window = next ? 'active' : 'idle';
  for (const l of listeners) l();
}

/** Starts watching (once, at boot): focus and visibility from the page, and the window's focus from Tauri. */
export function watchWindow(): void {
  if (started) return;
  started = true;
  const update = (): void => set(look());
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  active = look();
  document.documentElement.dataset.window = active ? 'active' : 'idle';
  // The web view's focus events can lag the window's own (a click into Klaud from another app): Tauri says it first.
  if (inApp())
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload }) => set(payload && document.visibilityState === 'visible')))
      .catch(() => undefined);
}

export const windowActive = (): boolean => active;

/** Called whenever you look at Klaud again, or look away. Returns a stop. */
export function onWindowActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** True while you're looking at Klaud's window (see above). */
export function useWindowActive(): boolean {
  return useSyncExternalStore(onWindowActive, windowActive, () => true);
}

/** A clock for "working · 12s": ticks every `every` ms while `running` and you're looking; on time again the moment you look back. */
export function useClock(running: boolean, every = 1000): number {
  const [now, setNow] = useState(Date.now);
  const looking = useWindowActive();
  useEffect(() => {
    if (!running || !looking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [running, looking, every]);
  return now;
}
