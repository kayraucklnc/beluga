import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * How late the daemon's main thread runs things (event-loop delay), logged every so often: p50
 * and p95 over the last period. Every screen and every Claude's events go through this thread, so
 * this is the number that says whether it stays responsive while many sessions stream.
 */

export const LAG_EVERY_MS = 30_000;

export interface LagStats {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** A period's delays in words (milliseconds). */
export const lagLine = (s: LagStats): string => `event loop delay: p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms`;

/** Measure the event loop and log it every `everyMs`; returns a stop. */
export function watchEventLoop(log: (line: string) => void, everyMs = LAG_EVERY_MS): () => void {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const ms = (ns: number): number => ns / 1e6;
  const timer = setInterval(() => {
    if (h.count) log(lagLine({ p50: ms(h.percentile(50)), p95: ms(h.percentile(95)), max: ms(h.max) }));
    h.reset();
  }, everyMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    h.disable();
  };
}
