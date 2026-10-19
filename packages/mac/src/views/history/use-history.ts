import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitHubState } from '@klaud/core/main-sync.js';
import type { CommitInfo, HistoryFilters } from '@klaud/workspaces/history.js';
import type { Project } from '@klaud/workspaces/types.js';
import { useApi, useApp } from '../../lib/klaud.js';

/** History's data: pages of commits, the filter choices, the GitHub repository, your worktrees' branches. */

export interface LogQuery {
  readonly branch: string;
  readonly author?: string;
  readonly path?: string;
}

export interface LogState {
  readonly commits: readonly CommitInfo[];
  readonly loading: boolean;
  readonly error?: string;
  /** More to load (scroll down). */
  readonly more: boolean;
  readonly loadMore: () => void;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Commits for a project or worktree, a page at a time. A new query starts over; a new `version`
 * (a fetch, a commit) reloads what's loaded while the list on screen stays. After an error it
 * stops asking until the query or version changes (no retry loop while the end is in view).
 */
export function useLog(target: string, query: LogQuery, pageSize: number, version = ''): LogState {
  const api = useApi();
  const [commits, setCommits] = useState<readonly CommitInfo[]>([]);
  const [next, setNext] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const token = useRef(0);
  const key = JSON.stringify([target, query.branch, query.author ?? '', query.path ?? '', pageSize]);
  const lastKey = useRef(key);
  const loaded = useRef(0);
  const live = useRef({ next, loading, error });
  live.current = { next, loading, error };
  const base = (): { branch: string; author?: string; path?: string } => ({ branch: query.branch, ...(query.author ? { author: query.author } : {}), ...(query.path ? { path: query.path } : {}) });

  useEffect(() => {
    const mine = ++token.current;
    const fresh = lastKey.current !== key;
    lastKey.current = key;
    if (fresh) {
      setCommits([]);
      setNext(undefined);
      loaded.current = 0;
    }
    setError(undefined);
    setLoading(true);
    // A refresh asks for as much as is on screen (up to the page limit), so the list doesn't shrink.
    const limit = Math.min(300, Math.max(pageSize, fresh ? 0 : loaded.current));
    api.git
      .log(target, { ...base(), limit })
      .then(
        (page) => {
          if (mine !== token.current) return;
          setCommits(page.commits);
          setNext(page.next);
          loaded.current = page.commits.length;
        },
        (err: unknown) => mine === token.current && setError(errorText(err)),
      )
      .finally(() => mine === token.current && setLoading(false));
  }, [key, version]);

  const loadMore = useCallback((): void => {
    const { next: cursor, loading: busy, error: failed } = live.current;
    if (!cursor || busy || failed) return;
    const mine = ++token.current;
    setLoading(true);
    api.git
      .log(target, { ...base(), limit: pageSize, before: cursor })
      .then(
        (page) => {
          if (mine !== token.current) return;
          setCommits((list) => {
            const seen = new Set(list.map((c) => c.hash));
            const all = [...list, ...page.commits.filter((c) => !seen.has(c.hash))];
            loaded.current = all.length;
            return all;
          });
          setNext(page.next);
        },
        (err: unknown) => mine === token.current && setError(errorText(err)),
      )
      .finally(() => mine === token.current && setLoading(false));
  }, [key]);

  return { commits, loading, ...(error ? { error } : {}), more: Boolean(next) && !error, loadMore };
}

/** Branches, tags and authors for the filters. */
export function useFilters(target: string, version = ''): HistoryFilters | undefined {
  const api = useApi();
  const [filters, setFilters] = useState<HistoryFilters>();
  useEffect(() => {
    let alive = true;
    api.git.filters(target).then(
      (f) => alive && setFilters(f),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [target, version]);
  return filters;
}

/** What GitHub says, shared by everything on screen for a few minutes (the core keeps it an hour). */
const github = new Map<string, { job: Promise<GitHubState>; at: number }>();
const GITHUB_UI_TTL_MS = 5 * 60_000;

/** The project's GitHub repository and gh's numbers. */
export function useGitHub(projectId: string | undefined): { state: GitHubState | undefined; refresh: () => Promise<GitHubState | undefined>; loading: boolean } {
  const api = useApi();
  const [state, setState] = useState<GitHubState>();
  const [loading, setLoading] = useState(false);
  const current = useRef(projectId);
  current.current = projectId;
  const load = (force: boolean): Promise<GitHubState | undefined> => {
    const id = projectId;
    if (!id) return Promise.resolve(undefined);
    const cached = github.get(id);
    const fresh = cached && Date.now() - cached.at < GITHUB_UI_TTL_MS;
    const job = !force && fresh ? cached.job : api.git.github(id, force);
    if (force || !fresh) github.set(id, { job, at: Date.now() });
    setLoading(true);
    return job.then(
      (s) => {
        // Another project is on screen by now: its own answer will come.
        if (current.current === id) {
          setState(s);
          setLoading(false);
        }
        return s;
      },
      () => {
        github.delete(id);
        if (current.current === id) setLoading(false);
        return undefined;
      },
    );
  };
  useEffect(() => {
    setState(undefined);
    void load(false);
  }, [projectId]);
  return { state, refresh: () => load(true), loading };
}

/** Your worktrees' branches in a project (branch → workspace), for the highlighted pills. */
export function useWorktreeBranches(project: Project | undefined): ReadonlyMap<string, { id: string; name: string }> {
  return useMemo(() => new Map((project?.workspaces ?? []).filter((w) => w.kind === 'worktree' && !w.archived && w.branch).map((w) => [w.branch!, { id: w.id, name: w.name }] as const)), [project?.workspaces]);
}

/** The project a history target belongs to (a project id, or one of its workspaces). */
export function useHistoryProject(target: string): Project | undefined {
  return useApp((st) => st.projects.find((p) => p.root && (p.id === target || p.workspaces.some((w) => w.id === target))));
}

/** Changes when what History shows may have moved: a fetch, a commit, a checkout. */
export function useHistoryVersion(project: Project | undefined): string {
  if (!project) return '';
  const s = project.sync;
  const trees = project.workspaces
    .filter((w) => w.kind !== 'chat' && !w.archived)
    .map((w) => `${w.branch ?? ''}:${w.status?.ahead ?? 0}:${w.status?.behind ?? 0}`)
    .join(',');
  return `${s?.fetchedAt ?? 0}:${s?.ahead ?? 0}:${s?.behind ?? 0}:${s?.current ?? ''}|${trees}`;
}
