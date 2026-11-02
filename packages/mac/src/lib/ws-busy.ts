import { useCallback, useSyncExternalStore } from 'react';
import { isBusy, subscribeBusy } from './ws-busy-model.js';

export { whileBusy } from './ws-busy-model.js';

/** This worktree's git or GitHub step is under way (see ws-busy-model.ts). */
export function useWsBusy(wsId: string): boolean {
  return useSyncExternalStore(
    subscribeBusy,
    useCallback(() => isBusy(wsId), [wsId]),
  );
}
