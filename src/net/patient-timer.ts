/**
 * Timers for network deadlines that only count time the event loop was free.
 *
 * The host's daemon dials its own hub in the same process (ws://127.0.0.1). When the loop is
 * blocked (a long sync call) or the Mac sleeps, a plain timer fires the moment the loop wakes,
 * before the reply that has been waiting all along is read: "Opening handshake has timed out"
 * on a hub that is right there. A late tick here counts as at most one step, so the reply gets
 * its turn first.
 */

const STEP_MS = 1_000;

/** A tick this much later than planned means the loop was stalled or asleep. */
export const isLate = (gapMs: number, plannedMs: number): boolean => gapMs > plannedMs * 1.5 + 250;

/** Call `fn` once `ms` of free loop time has passed. Returns a cancel function. */
export function patientTimeout(ms: number, fn: () => void, step = STEP_MS): () => void {
  let awake = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    awake += isLate(gap, step) ? step : gap;
    if (awake < ms) return;
    clearInterval(timer);
    fn();
  }, step);
  timer.unref?.();
  return () => clearInterval(timer);
}
