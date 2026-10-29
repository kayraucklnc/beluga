import { useEffect, useMemo, useRef, useState } from 'react';
import type { GhRunFull, GhWorkflow, RunsList } from '@beluga/core/ci/model.js';
import { isLive, pollEvery } from '@beluga/core/ci/model.js';
import type { GitHubRepo } from '@beluga/workspaces/github.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { openSheet } from '../lib/sheets.js';
import { keepSeen, lastSeen } from '../lib/last-seen.js';
import { onWindowActive, useClock, windowActive } from '../lib/window-active.js';

/**
 * What the Actions screens share: a project's runs and one run, read through the core and asked
 * for again by themselves while something runs (every few seconds) and now and then otherwise,
 * only while you're looking at the window; a clock for the times that grow; and acting on a run.
 */

const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

/**
 * Ask again after `every(data)` ms, while the window shows; `poke` asks now. A new key starts over.
 * With `keep`, the last answer is kept (lib/last-seen.ts) and shown at once while the fresh one comes.
 */
function usePolled<T>(key: string, ask: ((force: boolean) => Promise<T>) | undefined, every: (data: T) => number, keep?: string): { readonly data?: T; readonly error?: string; readonly loading: boolean; readonly poke: () => void } {
  const [got, setGot] = useState<{ readonly key: string; readonly data?: T; readonly error?: string }>();
  const [loading, setLoading] = useState(false);
  const [nudge, setNudge] = useState(0);
  const forced = useRef(false);
  useEffect(() => {
    if (!ask) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWaiting: (() => void) | undefined;
    const run = (): void => {
      if (gone) return;
      // Looking away: look again the moment you're back (GitHub isn't asked for nobody).
      if (!windowActive()) {
        const stop = onWindowActive(() => {
          if (!windowActive()) return;
          stop();
          run();
        });
        stopWaiting = stop;
        return;
      }
      const force = forced.current;
      forced.current = false;
      setLoading(true);
      ask(force).then(
        (data) => {
          if (gone) return;
          setGot({ key, data });
          if (keep) keepSeen(`${keep}:${key}`, data);
          setLoading(false);
          timer = setTimeout(run, every(data));
        },
        (err: unknown) => {
          if (gone) return;
          setGot((g) => ({ key, ...(g?.key === key && g.data !== undefined ? { data: g.data } : {}), error: message(err) }));
          setLoading(false);
          timer = setTimeout(run, 60_000);
        },
      );
    };
    run();
    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
      stopWaiting?.();
    };
  }, [key, nudge]);
  const kept = keep && key ? lastSeen<T>(`${keep}:${key}`) : undefined;
  const shown = got?.key === key ? got : kept !== undefined ? { key, data: kept } : undefined;
  return {
    ...(shown?.data !== undefined ? { data: shown.data } : {}),
    ...(shown?.error ? { error: shown.error } : {}),
    loading,
    poke: () => {
      forced.current = true;
      setNudge((n) => n + 1);
    },
  };
}

/** A project's latest runs (one workflow's, one branch's), kept current while it shows. */
export function useRuns(projectId: string | undefined, query: { readonly workflow?: string; readonly branch?: string } = {}): { readonly list?: RunsList; readonly error?: string; readonly loading: boolean; readonly refresh: () => void } {
  const api = useApi();
  const key = projectId ? `${projectId}\0${query.workflow ?? ''}\0${query.branch ?? ''}` : '';
  const ask = projectId ? (force: boolean) => api.ci.runs(projectId, { ...(query.workflow ? { workflow: query.workflow } : {}), ...(query.branch ? { branch: query.branch } : {}), ...(force ? { force: true } : {}) }) : undefined;
  const { data, error, loading, poke } = usePolled<RunsList>(key, ask, (l) => (l.kind === 'github' ? pollEvery(l.runs) : 120_000), 'ci.runs');
  return { ...(data ? { list: data } : {}), ...(error ? { error } : {}), loading, refresh: poke };
}

/** One run with its jobs and steps, every few seconds while it runs. */
export function useRun(projectId: string, id: number): { readonly data?: { readonly repo: GitHubRepo; readonly run: GhRunFull }; readonly error?: string; readonly loading: boolean; readonly refresh: () => void } {
  const api = useApi();
  const { data, error, loading, poke } = usePolled(`${projectId}#${id}`, (force) => api.ci.run(projectId, id, force ? { force: true } : undefined), (d) => (isLive(d.run) ? 3_000 : 60_000), 'ci.run');
  return { ...(data ? { data } : {}), ...(error ? { error } : {}), loading, refresh: poke };
}

/** The project's workflows and their files (read again now and then: you may be editing one). */
export function useWorkflows(projectId: string | undefined): { readonly data?: { readonly repo: GitHubRepo; readonly workflows: readonly GhWorkflow[] }; readonly error?: string; readonly loading: boolean; readonly refresh: () => void } {
  const api = useApi();
  const { data, error, loading, poke } = usePolled(projectId ?? '', projectId ? (force) => api.ci.workflows(projectId, force ? { force: true } : undefined) : undefined, () => 60_000, 'ci.workflows');
  return { ...(data ? { data } : {}), ...(error ? { error } : {}), loading, refresh: poke };
}

/** Now, ticking each second while `live` and you're looking (a running thing's time grows). */
export const useNow = (live: boolean): number => useClock(live);

/** Acting on runs: errors as a toast, and the places a run leads to. */
export function useCiActions() {
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  return useMemo(() => {
    const act = async (run: () => Promise<unknown>, done: string): Promise<boolean> => {
      try {
        await run();
        toast(client, done, 'success');
        return true;
      } catch (err) {
        toast(client, message(err), 'error');
        return false;
      }
    };
    return {
      rerun: (projectId: string, id: number, failed: boolean) => act(() => api.ci.rerun(projectId, id, failed ? { failed: true } : undefined), failed ? 'Running the failed jobs again' : 'Running it again'),
      cancel: (projectId: string, id: number, title: string, then?: () => void): void =>
        openSheet({ kind: 'confirm', title: 'Cancel this run?', message: `“${title}” stops where it is. You can run it again later.`, confirm: 'Cancel Run', destructive: true, run: () => void act(() => api.ci.cancel(projectId, id), 'Cancelling the run').then((ok) => ok && then?.()) }),
      log: (projectId: string, jobId: number): Promise<string> => api.ci.log(projectId, jobId),
      openRun: (projectId: string, runId: number): void => actions.run({ type: 'view', view: { kind: 'gh_run', projectId, runId } }),
      openList: (projectId?: string, page?: 'workflows'): void => actions.run({ type: 'view', view: { kind: 'actions', ...(projectId ? { projectId } : {}), ...(page ? { page } : {}) } }),
      openOnGitHub: (url: string): void => actions.openLink({ kind: 'url', url }),
    };
  }, [api, client, actions]);
}
