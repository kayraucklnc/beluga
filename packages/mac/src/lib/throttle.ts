/**
 * Runs `run` at most once per `gap()` ms however often it's asked: the first ask runs at once,
 * asks within the gap become one run at its end. The gap is read at each ask, so it can depend
 * on whether you're looking at the window (the Dock badge: 1 s in front, 5 s behind).
 */
export interface Throttle {
  readonly request: () => void;
  readonly stop: () => void;
}

export interface Clock {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function throttle(run: () => void, gap: () => number, clock: Clock = realClock): Throttle {
  let last = -Infinity;
  let timer: unknown;
  const fire = (): void => {
    timer = undefined;
    last = clock.now();
    run();
  };
  return {
    request: () => {
      if (timer !== undefined) return;
      const wait = last + gap() - clock.now();
      if (wait <= 0) fire();
      else timer = clock.setTimeout(fire, wait);
    },
    stop: () => {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
