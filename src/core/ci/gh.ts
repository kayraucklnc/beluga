import type { GhRunner, GitHubRepo } from '../../workspaces/github.js';
import type { GhConclusion, GhJob, GhRun, GhRunStatus, GhStep, GhWorkflow } from './model.js';

/**
 * A repository's GitHub Actions through the GitHub CLI (`gh api`), with the sign-in people
 * already have: its latest runs (all, one workflow's, one branch's), a run's jobs and steps, the
 * workflow file a run ran, the workflows, a failed job's log, and re-running or cancelling a run.
 */

/** How many runs one look reads. */
export const RUNS_PAGE = 30;
/** How many jobs a run's page reads (a big matrix has more: GitHub's own page shows the rest). */
export const JOBS_PAGE = 100;
/** How much of a job's log is kept: its end, where it failed. */
export const LOG_TAIL_LINES = 400;

export interface CiSource {
  runs(repo: GitHubRepo, query: { readonly workflow?: string; readonly branch?: string }): Promise<{ readonly runs: readonly GhRun[]; readonly more: boolean }>;
  run(repo: GitHubRepo, id: number): Promise<GhRun>;
  jobs(repo: GitHubRepo, id: number): Promise<readonly GhJob[]>;
  /** A file of the repository at a commit (or its default branch); undefined when it isn't there. */
  file(repo: GitHubRepo, path: string, ref?: string): Promise<string | undefined>;
  workflows(repo: GitHubRepo): Promise<readonly GhWorkflow[]>;
  /** The end of a job's log. */
  log(repo: GitHubRepo, jobId: number): Promise<string>;
  rerun(repo: GitHubRepo, id: number, failedOnly: boolean): Promise<void>;
  cancel(repo: GitHubRepo, id: number): Promise<void>;
}

const hostArgs = (repo: GitHubRepo): string[] => (repo.host === 'github.com' ? [] : ['--hostname', repo.host]);
const at = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) || 0 : 0);
const login = (u: unknown): string | undefined => (u && typeof u === 'object' && typeof (u as { login?: unknown }).login === 'string' ? (u as { login: string }).login : undefined);

const STATUSES: ReadonlySet<string> = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);
const CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const status = (v: unknown): GhRunStatus => (typeof v === 'string' && STATUSES.has(v) ? (v as GhRunStatus) : 'queued');
const conclusion = (v: unknown): GhConclusion | undefined => (typeof v === 'string' && CONCLUSIONS.has(v) ? (v as GhConclusion) : undefined);

/** One run of GitHub's REST answer, in Beluga's words; undefined for nonsense. */
export function parseRun(raw: unknown): GhRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number') return undefined;
  const st = status(r.status);
  const end = st === 'completed' ? conclusion(r.conclusion) : undefined;
  const path = typeof r.path === 'string' && r.path.startsWith('.github/') ? r.path.split('@')[0] : undefined;
  const commit = r.head_commit && typeof r.head_commit === 'object' ? (r.head_commit as { message?: unknown }).message : undefined;
  const title = (typeof r.display_title === 'string' && r.display_title.trim()) || (typeof commit === 'string' && commit.split('\n')[0]!.trim()) || (typeof r.name === 'string' ? r.name : `Run ${r.id}`);
  const actor = login(r.triggering_actor) ?? login(r.actor);
  const createdAt = at(r.created_at);
  return {
    id: r.id,
    workflow: typeof r.name === 'string' && r.name ? r.name : path ? path.split('/').pop()! : 'Workflow',
    ...(path ? { path } : {}),
    title,
    number: typeof r.run_number === 'number' ? r.run_number : 0,
    attempt: typeof r.run_attempt === 'number' ? r.run_attempt : 1,
    event: typeof r.event === 'string' ? r.event : 'push',
    status: st,
    ...(end ? { conclusion: end } : {}),
    ...(typeof r.head_branch === 'string' && r.head_branch ? { branch: r.head_branch } : {}),
    sha: typeof r.head_sha === 'string' ? r.head_sha : '',
    ...(actor ? { actor } : {}),
    prs: Array.isArray(r.pull_requests) ? r.pull_requests.map((p) => (p as { number?: unknown })?.number).filter((n): n is number => typeof n === 'number') : [],
    url: typeof r.html_url === 'string' ? r.html_url : '',
    createdAt,
    startedAt: at(r.run_started_at) || createdAt,
    updatedAt: at(r.updated_at) || createdAt,
  };
}

/** A runs list (`{ total_count, workflow_runs }`). */
export function parseRuns(json: string): { readonly runs: GhRun[]; readonly total: number } {
  const raw = JSON.parse(json) as { total_count?: unknown; workflow_runs?: unknown };
  if (!Array.isArray(raw?.workflow_runs)) throw new Error('GitHub gave an answer Beluga doesn’t understand');
  const runs = raw.workflow_runs.map(parseRun).filter((r): r is GhRun => Boolean(r));
  return { runs, total: typeof raw.total_count === 'number' ? raw.total_count : runs.length };
}

function parseStep(raw: unknown): GhStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string') return undefined;
  const st = status(s.status);
  const end = st === 'completed' ? conclusion(s.conclusion) : undefined;
  return {
    number: typeof s.number === 'number' ? s.number : 0,
    name: s.name,
    status: st,
    ...(end ? { conclusion: end } : {}),
    ...(at(s.started_at) ? { startedAt: at(s.started_at) } : {}),
    ...(at(s.completed_at) ? { completedAt: at(s.completed_at) } : {}),
  };
}

export function parseJob(raw: unknown): GhJob | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const j = raw as Record<string, unknown>;
  if (typeof j.id !== 'number' || typeof j.name !== 'string') return undefined;
  const st = status(j.status);
  const end = st === 'completed' ? conclusion(j.conclusion) : undefined;
  return {
    id: j.id,
    name: j.name,
    status: st,
    ...(end ? { conclusion: end } : {}),
    ...(at(j.started_at) ? { startedAt: at(j.started_at) } : {}),
    ...(at(j.completed_at) ? { completedAt: at(j.completed_at) } : {}),
    url: typeof j.html_url === 'string' ? j.html_url : '',
    ...(typeof j.runner_name === 'string' && j.runner_name ? { runner: j.runner_name } : {}),
    steps: Array.isArray(j.steps) ? j.steps.map(parseStep).filter((s): s is GhStep => Boolean(s)) : [],
  };
}

export function parseJobs(json: string): GhJob[] {
  const raw = JSON.parse(json) as { jobs?: unknown };
  if (!Array.isArray(raw?.jobs)) throw new Error('GitHub gave an answer Beluga doesn’t understand');
  return raw.jobs.map(parseJob).filter((j): j is GhJob => Boolean(j));
}

export function parseWorkflows(json: string): GhWorkflow[] {
  const raw = JSON.parse(json) as { workflows?: unknown };
  if (!Array.isArray(raw?.workflows)) throw new Error('GitHub gave an answer Beluga doesn’t understand');
  return raw.workflows.flatMap((w): GhWorkflow[] => {
    const o = w as Record<string, unknown>;
    if (!o || typeof o.id !== 'number' || typeof o.path !== 'string') return [];
    return [{ id: o.id, name: typeof o.name === 'string' ? o.name : o.path, path: o.path, state: typeof o.state === 'string' ? o.state : 'active', url: typeof o.html_url === 'string' ? o.html_url : '' }];
  });
}

/**
 * The end of a job's log, made easier to read: GitHub's timestamps and colour codes off, at most
 * LOG_TAIL_LINES lines.
 */
export function logTail(text: string, lines = LOG_TAIL_LINES): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes in the log
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '').replace(/^\uFEFF/, '');
  const all = clean
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, ''))
    // GitHub's own markers: folds go, a step's name and an error keep their words.
    .filter((l) => !/^##\[endgroup\]/.test(l))
    .map((l) => l.replace(/^##\[group\]/, '▸ ').replace(/^##\[(error|warning|notice)\]/, (_, k: string) => `${k[0]!.toUpperCase()}${k.slice(1)}: `));
  while (all.length && !all.at(-1)!.trim()) all.pop();
  return all.slice(-lines).join('\n');
}

/** The real thing: `gh api` against the repository's host. */
export function ghCiSource(run: GhRunner): CiSource {
  const base = (repo: GitHubRepo): string => `repos/${repo.owner}/${repo.repo}/actions`;
  return {
    async runs(repo, query) {
      const path = query.workflow ? `${base(repo)}/workflows/${encodeURIComponent(query.workflow.split('/').pop()!)}/runs` : `${base(repo)}/runs`;
      const out = await run(['api', ...hostArgs(repo), '-X', 'GET', path, '-f', `per_page=${RUNS_PAGE}`, ...(query.branch ? ['-f', `branch=${query.branch}`] : [])]);
      const { runs, total } = parseRuns(out);
      return { runs, more: total > runs.length };
    },
    async run(repo, id) {
      const r = parseRun(JSON.parse(await run(['api', ...hostArgs(repo), `${base(repo)}/runs/${id}`])));
      if (!r) throw new Error(`Couldn’t read run ${id}`);
      return r;
    },
    async jobs(repo, id) {
      return parseJobs(await run(['api', ...hostArgs(repo), '-X', 'GET', `${base(repo)}/runs/${id}/jobs`, '-f', `per_page=${JOBS_PAGE}`, '-f', 'filter=latest']));
    },
    async file(repo, path, ref) {
      const out = await run(['api', ...hostArgs(repo), '-X', 'GET', `repos/${repo.owner}/${repo.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, '-H', 'Accept: application/vnd.github.raw', ...(ref ? ['-f', `ref=${ref}`] : [])]).catch(() => undefined);
      return out;
    },
    async workflows(repo) {
      return parseWorkflows(await run(['api', ...hostArgs(repo), '-X', 'GET', `${base(repo)}/workflows`, '-f', 'per_page=100']));
    },
    async log(repo, jobId) {
      return logTail(await run(['api', ...hostArgs(repo), `${base(repo)}/jobs/${jobId}/logs`]));
    },
    async rerun(repo, id, failedOnly) {
      await run(['api', ...hostArgs(repo), '-X', 'POST', `${base(repo)}/runs/${id}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`]);
    },
    async cancel(repo, id) {
      await run(['api', ...hostArgs(repo), '-X', 'POST', `${base(repo)}/runs/${id}/cancel`]);
    },
  };
}
