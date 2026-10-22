import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { Plan, PlansState } from '@klaud/core/plans/model.js';
import { type PlanView, liveFrom, planView } from '@klaud/core/plans/progress.js';
import { toast, useApi, useApp, useKlaud } from '../lib/klaud.js';
import { useActions } from '../lib/actions.js';
import { sameDeep, sameItems } from '../lib/stable.js';

/** What the Plans screens share: the plans, a plan where it stands (live), and acting on plans. */

export const usePlans = (): PlansState => useApp((s) => s.plans);

/** A plan where it stands now: from the board and what Claude is doing in each worktree. */
export function usePlanView(plan: Plan | undefined): PlanView | undefined {
  // Worked out again only when what it's made of changes, and given out again only when it reads
  // differently: a Claude streaming in another conversation doesn't draw a plan's row again (KLD-48).
  const made = useRef<{ readonly from: readonly unknown[]; readonly view: PlanView | undefined }>(undefined);
  return useApp((s) => {
    const from = [plan, s.board, s.log, s.questions, s.approvals];
    if (made.current && sameItems(made.current.from, from)) return made.current.view;
    const view = plan ? planView(plan, s.board, liveFrom(s)) : undefined;
    made.current = { from, view };
    return view;
  }, sameDeep);
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
