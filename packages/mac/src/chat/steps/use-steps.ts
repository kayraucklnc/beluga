import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepRecord, StepSummary } from '@klaud/shared/steps.js';
import { useApi } from '../../lib/klaud.js';

/**
 * A Claude card's steps in detail (`agent.steps`): fetched when the card shows, then every
 * second while Claude works (only what changed comes back), and once more when it ends.
 * `undefined` steps: not loaded yet, or this computer has no details (someone else's Claude).
 */
export function useAgentSteps(channel: string, itemId: string, running: boolean, change: string, enabled = true): { steps: readonly StepSummary[] | undefined; missing: boolean } {
  const api = useApi();
  const [state, setState] = useState<{ key: string; steps?: readonly StepSummary[]; missing: boolean }>({ key: '', missing: false });
  const key = `${channel}/${itemId}`;
  const version = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const again = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    // One at a time; a change while one is out asks once more after it.
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const page = await api.agent.steps(channel, itemId, version.current);
      if (page.unchanged) return;
      version.current = page.version;
      setState({ key, missing: Boolean(page.missing), ...(page.missing ? {} : { steps: page.steps }) });
    } catch {
      // The daemon went away for a moment: the next tick tries again.
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [api, channel, itemId, key, enabled]);

  useEffect(() => {
    version.current = undefined;
    setState({ key, missing: false });
  }, [key]);

  // When the card changes (a new step line, a status), and when Claude stops.
  useEffect(() => {
    void load();
  }, [load, change, running]);

  useEffect(() => {
    if (!running || !enabled) return;
    const t = setInterval(() => void load(), 1000);
    return () => clearInterval(t);
  }, [load, running, enabled]);

  return state.key === key ? { steps: state.steps, missing: state.missing } : { steps: undefined, missing: false };
}

/**
 * One step's details, fetched when it's opened (and again while it's still running, so its
 * output shows when it arrives). `load` reads it from wherever the step lives.
 */
export function useStepDetail(load: () => Promise<StepRecord | undefined>, open: boolean, change: string): { record?: StepRecord; loading: boolean; gone: boolean } {
  const [state, setState] = useState<{ record?: StepRecord; loading: boolean; gone: boolean }>({ loading: false, gone: false });
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState((prev) => ({ ...prev, loading: !prev.record }));
    loader
      .current()
      .then((record) => alive && setState(record ? { record, loading: false, gone: false } : { loading: false, gone: true }))
      .catch(() => alive && setState((prev) => ({ ...prev, loading: false, gone: !prev.record })));
    return () => {
      alive = false;
    };
  }, [open, change]);
  return state;
}
