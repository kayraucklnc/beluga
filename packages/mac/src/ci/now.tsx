import { createContext, type ReactNode, useContext } from 'react';
import { useNow } from './use-ci.js';

/**
 * A page's one clock (useNow), handed down without drawing the page again: each second only
 * the bits of time text (NowText) are drawn again, all on the same tick, with the same values
 * the page's own clock gave them before.
 */
const NowContext = createContext<number | undefined>(undefined);

export function Ticking({ live, children }: { live: boolean; children: ReactNode }) {
  const now = useNow(live);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

/** Text that reads the clock: `at` when given (a caller's own clock), else the page's (Ticking). */
export function NowText({ at, children }: { at?: number | undefined; children: (now: number) => ReactNode }) {
  const ticking = useContext(NowContext);
  return <>{children(at ?? ticking ?? Date.now())}</>;
}
