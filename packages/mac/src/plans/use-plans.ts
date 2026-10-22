import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Plan, PlansState } from '@klaud/core/plans/model.js';
import { type PlanView, liveFrom, planView } from '@klaud/core/plans/progress.js';
import { toast, useApi, useApp, useKlaud } from '../lib/klaud.js';
import { useActions } from '../lib/actions.js';

/** What the Plans screens share: the plans, a plan where it stands (live), and acting on plans. */

export const usePlans = (): PlansState => useApp((s) => s.plans);

/** A plan where it stands now: from the board and what Claude is doing in each worktree. */
export function usePlanView(plan: Plan | undefined): PlanView | undefined {
  const board = useApp((s) => s.board);
  const log = useApp((s) => s.log);
  const questions = useApp((s) => s.questions);
  const approvals = useApp((s) => s.approvals);
  return useMemo(() => (plan ? planView(plan, board, liveFrom({ log, questions, approvals })) : undefined), [plan, board, log, questions, approvals]);
}

// One clock for every card that shows how long a step has run: it ticks only while one does.
const CLOCK_MS = 15_000;
const clockSubs = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | undefined;
let clockNow = Date.now();
const tickClock = (): void => {
  clockNow = Date.now();
  clockSubs.forEach((f) => f());
};
function subscribeClock(onChange: () => void): () => void {
  clockSubs.add(onChange);
  clockNow = Date.now();
  clockTimer ??= setInterval(tickClock, CLOCK_MS);
  return () => {
    clockSubs.delete(onChange);
    if (!clockSubs.size) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}
const noClock = (): (() => void) => () => undefined;

/** Now, for a card showing elapsed time (`on`: it shows some); it moves every few seconds while on. */
export function useClock(on: boolean): number {
  return useSyncExternalStore(on ? subscribeClock : noClock, () => (on ? clockNow : 0));
}

/**
 * The plan's own conversation, loaded: after a restart it's only on disk until something asks for
 * it (workspaces.load). False until that answered for this channel; true for one that isn't a workspace's.
 */
export function useConversationLoaded(channel: string): boolean {
  const api = useApi();
  const wsId = channel.startsWith('ws:') ? channel.slice(3) : undefined;
  const [loadedFor, setLoadedFor] = useState<string>();
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    void api.workspaces
      .load(wsId)
      .catch(() => undefined)
      .then(() => alive && setLoadedFor(wsId));
    return () => {
      alive = false;
    };
  }, [api, wsId]);
  return !wsId || loadedFor === wsId;
}

const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

/** The plans API with errors shown (a toast), and going places. */
export function usePlanActions() {
  const api = useApi();
  const { client } = useKlaud();
  const actions = useActions();
  return useMemo(() => {
    const act = async <T,>(run: () => Promise<T>, done?: string): Promise<T | undefined> => {
      try {
        const result = await run();
        if (done) toast(client, done, 'success');
        return result;
      } catch (err) {
        toast(client, message(err), 'error');
        return undefined;
      }
    };
    return {
      api: api.plans,
      act,
      open: (id: string): void => actions.run({ type: 'view', view: { kind: 'plan', id } }),
      openList: (projectId?: string): void => actions.run({ type: 'view', view: { kind: 'plans', ...(projectId ? { projectId } : {}) } }),
      openTask: (issueId: string): void => actions.run({ type: 'view', view: { kind: 'task', id: issueId } }),
      openWorktree: (workspaceId: string): void => actions.run({ type: 'open_ws', id: workspaceId, tab: 'chat' }),
    };
  }, [api, client, actions]);
}
