import { useCallback, useEffect, useRef, useState } from 'react';
import type { CcStep } from '@klaud/core/claude-code/model.js';
import { useApi } from '../lib/klaud.js';

/**
 * A session's (or agent's) steps, live: all of the newest at first, then only what changed each
 * time `version` moves (the shared state says it wrote something). Steps still running are asked
 * for again, so a tool call turns done in place.
 */
export interface LiveSteps {
  readonly steps: readonly CcStep[];
  readonly more: boolean;
  readonly missing: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly loadEarlier: () => void;
}

const merge = (old: readonly CcStep[], fresh: readonly CcStep[]): CcStep[] => {
  if (!fresh.length) return [...old];
  const from = fresh[0]!.seq;
  return [...old.filter((s) => s.seq < from), ...fresh];
};

export function useSteps(sessionId: string, agentId: string | undefined, version: string): LiveSteps {
  const api = useApi();
  const [state, setState] = useState<{ key: string; steps: readonly CcStep[]; more: boolean; missing: boolean; loading: boolean; error?: string }>({ key: '', steps: [], more: false, missing: false, loading: true });
  const key = `${sessionId}/${agentId ?? ''}`;
  const latest = useRef(state);
  latest.current = state;
  const busy = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const cur = latest.current.key === key ? latest.current.steps : [];
      const pending = cur.find((s) => s.status === 'running');
      const after = pending ? pending.seq - 1 : cur.at(-1)?.seq;
      const page = await api.claudeCode.steps(sessionId, agentId, after !== undefined ? { after } : {});
      const gap = after !== undefined && page.steps.length > 0 && page.steps[0]!.seq > after + 1;
      if (gap) {
        const full = await api.claudeCode.steps(sessionId, agentId, {});
        setState({ key, steps: full.steps, more: full.more, missing: Boolean(full.missing), loading: false });
      } else {
        setState((prev) => (prev.key === key ? { ...prev, steps: merge(prev.steps, page.steps), missing: Boolean(page.missing), loading: false, ...(after === undefined ? { more: page.more } : {}) } : { key, steps: page.steps, more: page.more, missing: Boolean(page.missing), loading: false }));
      }
    } catch (err) {
      setState((prev) => ({ ...prev, key, loading: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void refresh();
      }
    }
  }, [api, key, sessionId, agentId]);

  // Another session or agent: start over.
  useEffect(() => {
    setState({ key, steps: [], more: false, missing: false, loading: true });
    latest.current = { key, steps: [], more: false, missing: false, loading: true };
  }, [key]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const loadEarlier = useCallback(() => {
    const first = latest.current.steps[0];
    if (!first) return;
    void api.claudeCode.steps(sessionId, agentId, { before: first.seq }).then((page) => setState((prev) => (prev.key === key ? { ...prev, steps: [...page.steps, ...prev.steps], more: page.more } : prev)));
  }, [api, key, sessionId, agentId]);

  const current = state.key === key ? state : { steps: [], more: false, missing: false, loading: true };
  return { ...current, loadEarlier };
}
