/**
 * Worktrees with a git or GitHub step under way (Create PR pushing, a merge, Update Branch…), for
 * as long as the window is open. The toolbar's branch button and the Changes panel say "Working…"
 * for that worktree only: switching to another one shows its own buttons, and coming back while
 * it's still going shows it working (one component, reused across worktrees, used to carry it over).
 * Pure, so it's tested on its own (tests/mac-ws-busy.test.ts); the hook is ws-busy.ts.
 */
const busy = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export const isBusy = (wsId: string): boolean => busy.has(wsId);

/** Runs `work` with the worktree busy until it settles; pressed again while it runs, nothing happens. */
export function whileBusy(wsId: string, work: () => Promise<unknown>): Promise<void> {
  if (busy.has(wsId)) return Promise.resolve();
  busy.add(wsId);
  notify();
  return work()
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      busy.delete(wsId);
      notify();
    });
}

export function subscribeBusy(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
