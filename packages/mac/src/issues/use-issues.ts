import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type GhIssueFull, type GhIssueState, type IssueStage, type IssuesList, issueStage, taskForIssue } from '@beluga/core/issues/model.js';
import type { GitHubRepo } from '@beluga/workspaces/github.js';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { useActions } from '../lib/actions.js';
import { type IssuesPrefs, readIssuesPrefs } from './issues-model.js';

/** What the Issues screens share: a project's issues and one issue (read through the core, kept a little while), how far Beluga got with each, and acting on them. */

// ---- reading

/** Lists and issues read lately, shared by everything on screen (the core keeps them a minute too). */
const lists = new Map<string, { readonly job: Promise<IssuesList>; readonly at: number }>();
const issues = new Map<string, { readonly job: Promise<{ readonly repo: GitHubRepo; readonly issue: GhIssueFull }>; readonly at: number }>();
const UI_TTL_MS = 30_000;

const message = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error: /, '') : String(err));

/** A project's open or closed issues (a search narrows them); `refresh` asks GitHub again. */
export function useIssueList(projectId: string | undefined, state: GhIssueState, search: string): { readonly list?: IssuesList; readonly loading: boolean; readonly error?: string; readonly refresh: () => void } {
  const api = useApi();
  const key = projectId ? `${projectId}\0${state}\0${search}` : '';
  const [got, setGot] = useState<{ readonly key: string; readonly list?: IssuesList; readonly error?: string }>();
  const [loading, setLoading] = useState(false);
  const current = useRef(key);
  current.current = key;
  const load = (force: boolean): void => {
    if (!projectId) return;
    const at = key;
    const kept = lists.get(at);
    const fresh = kept && Date.now() - kept.at < UI_TTL_MS;
    const job = !force && fresh ? kept.job : api.issues.list(projectId, { state, ...(search ? { search } : {}), ...(force ? { force: true } : {}) });
    if (force || !fresh) lists.set(at, { job, at: Date.now() });
    setLoading(true);
    job.then(
      (list) => {
        if (current.current !== at) return;
        setGot({ key: at, list });
        setLoading(false);
      },
      (err: unknown) => {
        lists.delete(at);
        if (current.current !== at) return;
        setGot({ key: at, error: message(err) });
        setLoading(false);
      },
    );
  };
  useEffect(() => load(false), [key]);
  // What's shown is for this project and search (the last one's stays while the next one loads, unless it was another project).
  const shown = got && (got.key === key || got.key.split('\0')[0] === projectId) ? got : undefined;
  return { ...(shown?.list ? { list: shown.list } : {}), ...(shown?.error ? { error: shown.error } : {}), loading, refresh: () => load(true) };
}

/** One issue in full (with its comments); `refresh` asks GitHub again. */
export function useIssue(projectId: string, number: number): { readonly data?: { readonly repo: GitHubRepo; readonly issue: GhIssueFull }; readonly error?: string; readonly loading: boolean; readonly refresh: () => void } {
  const api = useApi();
  const key = `${projectId}#${number}`;
  const [got, setGot] = useState<{ readonly key: string; readonly data?: { readonly repo: GitHubRepo; readonly issue: GhIssueFull }; readonly error?: string }>();
  const [loading, setLoading] = useState(false);
  const current = useRef(key);
  current.current = key;
  const load = (force: boolean): void => {
    const kept = issues.get(key);
    const fresh = kept && Date.now() - kept.at < UI_TTL_MS;
    const job = !force && fresh ? kept.job : api.issues.get(projectId, number, force ? { force: true } : undefined);
    if (force || !fresh) issues.set(key, { job, at: Date.now() });
    setLoading(true);
    const at = key;
    job.then(
      (data) => {
        if (current.current !== at) return;
        setGot({ key: at, data });
        setLoading(false);
      },
      (err: unknown) => {
        issues.delete(at);
        if (current.current !== at) return;
        setGot({ key: at, error: message(err) });
        setLoading(false);
      },
    );
  };
  useEffect(() => load(false), [key]);
  const shown = got?.key === key ? got : undefined;
  return { ...(shown?.data ? { data: shown.data } : {}), ...(shown?.error ? { error: shown.error } : {}), loading, refresh: () => load(true) };
}

/** Forget what was read of a project's issues (after commenting, say), so the next look asks again. */
export function forgetIssues(projectId: string, number?: number): void {
  for (const k of [...lists.keys()]) if (k.startsWith(`${projectId}\0`)) lists.delete(k);
  if (number !== undefined) issues.delete(`${projectId}#${number}`);
}

// ---- how far Beluga got with an issue

/** The issue's task, and what it's at: nothing yet, on the board, investigating, fixing, in review, done. */
export function useIssueStage(projectId: string, repo: Pick<GitHubRepo, 'owner' | 'repo'> | undefined, number: number): IssueStage {
  const task = useApp((s) => (repo ? taskForIssue(s.board, projectId, repo, number) : undefined));
  const places = task ? [task.carriedBy, task.worktrees.at(-1)].filter((w): w is string => Boolean(w)) : [];
  const live = useApp((s) => places.filter((id) => s.projects.some((p) => p.workspaces.some((w) => w.id === id && !w.archived))).join(' '));
  const working = useApp((s) => places.filter((id) => activityOf(s.log, `ws:${id}`).running).join(' '));
  return useMemo(() => issueStage(task, (id) => live.split(' ').includes(id), (id) => working.split(' ').includes(id)), [task, live, working]);
}

// ---- acting

/** The issues API with errors shown (a toast) instead of thrown, and the places an issue leads to. */
export function useIssueActions() {
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  return useMemo(() => {
    const act = async <T,>(run: () => Promise<T>, done?: (result: T) => string): Promise<T | undefined> => {
      try {
        const result = await run();
        if (done) toast(client, done(result), 'success');
        return result;
      } catch (err) {
        toast(client, message(err), 'error');
        return undefined;
      }
    };
    return {
      /** Claude finds out why and reproduces it, in a worktree of the issue's task. */
      investigate: (projectId: string, number: number) => act(() => api.issues.investigate(projectId, number), (w) => `Claude is investigating #${number} (${w.key})`),
      /** Claude fixes it and opens a pull request that closes it. */
      fix: (projectId: string, number: number) => act(() => api.issues.fix(projectId, number), (w) => `Claude is fixing #${number} (${w.key})`),
      /** On the board, written by Claude (`look`: after a quick look at the code). */
      toTask: (projectId: string, number: number, look = false) => act(() => api.issues.toTask(projectId, number, look ? { look: true } : undefined), (w) => (look ? `${w.key}: Claude is looking at the code to write it` : `#${number} is on the board as ${w.key}`)),
      comment: (projectId: string, number: number, body: string) =>
        act(
          async () => {
            const url = await api.issues.comment(projectId, number, body);
            forgetIssues(projectId, number);
            return url;
          },
          () => `Posted on #${number}`,
        ),
      openIssue: (projectId: string, number: number): void => actions.run({ type: 'view', view: { kind: 'gh_issue', projectId, number } }),
      openList: (projectId?: string): void => actions.run({ type: 'view', view: { kind: 'issues', ...(projectId ? { projectId } : {}) } }),
      openTask: (id: string): void => actions.run({ type: 'view', view: { kind: 'task', id } }),
      openWorktree: (id: string): void => actions.run({ type: 'open_ws', id, tab: 'chat' }),
      openOnGitHub: (url: string): void => actions.openLink({ kind: 'url', url }),
    };
  }, [api, client, actions]);
}

// ---- the view's prefs, per window

const KEY = 'beluga.issues.v1';
let prefs = readIssuesPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
const listeners = new Set<() => void>();

export function setIssuesPrefs(patch: Partial<IssuesPrefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // No storage: kept for this window.
  }
  for (const l of [...listeners]) l();
}

export function useIssuesPrefs(): IssuesPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => prefs,
  );
}
