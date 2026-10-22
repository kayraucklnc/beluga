/**
 * At most `max` of these at a time; the rest wait their turn (first come, first served). Refreshing
 * twenty worktrees then runs a few git processes at once, not forty.
 */
export interface Limiter {
  <T>(task: () => Promise<T>): Promise<T>;
  /** How many run now, and the most that ever ran at once (for tests and debugging). */
  readonly active: number;
  readonly peak: number;
}

export function limiter(max: number): Limiter {
  let active = 0;
  let peak = 0;
  const waiting: (() => void)[] = [];
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    // A slot freed while others wait is handed straight to the next one (see finally), never re-counted.
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    peak = Math.max(peak, active);
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  return Object.defineProperties(run, {
    active: { get: () => active },
    peak: { get: () => peak },
  }) as Limiter;
}
