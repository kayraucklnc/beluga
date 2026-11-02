import type { GitHubRepo } from '../../workspaces/github.js';

/**
 * A project's GitHub Actions as the screens see them (read through gh by core/ci/ci.ts): its
 * workflow runs, one run's jobs and their steps, and its workflow files. Browser-safe: the Mac
 * app runs it.
 */

/** GitHub's status of a run, a job or a step (`waiting`: for an approval; `requested`/`pending`: about to queue). */
export type GhRunStatus = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
/** How a completed one ended. */
export type GhConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed_out' | 'action_required' | 'startup_failure' | 'stale';

/** One workflow run, as a list shows it. */
export interface GhRun {
  readonly id: number;
  /** The workflow's name ("CI"). */
  readonly workflow: string;
  /** Where its file is (".github/workflows/ci.yml"); a dynamic one (Dependabot, Pages) has none. */
  readonly path?: string;
  /** What GitHub titles it with: the commit's first line, the pull request's title. */
  readonly title: string;
  readonly number: number;
  readonly attempt: number;
  /** What started it ("push", "pull_request", "schedule", "workflow_dispatch"). */
  readonly event: string;
  readonly status: GhRunStatus;
  readonly conclusion?: GhConclusion;
  readonly branch?: string;
  readonly sha: string;
  readonly actor?: string;
  /** The pull requests it ran for. */
  readonly prs: readonly number[];
  readonly url: string;
  readonly createdAt: number;
  /** When this attempt started (a re-run starts again). */
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface GhStep {
  readonly number: number;
  readonly name: string;
  readonly status: GhRunStatus;
  readonly conclusion?: GhConclusion;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface GhJob {
  readonly id: number;
  /** As GitHub shows it: the job's name, with its matrix values ("test (ubuntu-latest, 20)"), or "caller / job" for a reusable workflow's. */
  readonly name: string;
  readonly status: GhRunStatus;
  readonly conclusion?: GhConclusion;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly url: string;
  readonly runner?: string;
  readonly steps: readonly GhStep[];
}

/** A run in full: its jobs and their steps, and the workflow file it ran (from its commit). */
export interface GhRunFull extends GhRun {
  readonly jobs: readonly GhJob[];
  /** The workflow file at the run's commit (YAML), when GitHub has it. */
  readonly file?: string;
}

/** A workflow of the repository, with its file as it is in the project's folder (or on GitHub). */
export interface GhWorkflow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  /** "active", "disabled_manually"… */
  readonly state: string;
  readonly url: string;
  readonly file?: string;
}

/** What asking for a project's runs gives (the same shapes as IssuesList). */
export type RunsList =
  /** The project isn't on GitHub. */
  | { readonly kind: 'none' }
  /** The GitHub CLI isn't installed or signed in. */
  | { readonly kind: 'no_gh'; readonly repo: GitHubRepo }
  | { readonly kind: 'error'; readonly repo: GitHubRepo; readonly message: string }
  | { readonly kind: 'github'; readonly repo: GitHubRepo; readonly runs: readonly GhRun[]; /** More than were read. */ readonly more: boolean; readonly fetchedAt: number };

export interface RunsQuery {
  /** One workflow's runs (its file's path, ".github/workflows/ci.yml"). */
  readonly workflow?: string;
  readonly branch?: string;
  readonly force?: boolean;
}

/** How a run, job or step is going, in one word the screens colour by. */
export type RunTone = 'running' | 'queued' | 'waiting' | 'passed' | 'failed' | 'cancelled' | 'skipped';

export function runTone(x: { readonly status: GhRunStatus; readonly conclusion?: GhConclusion | undefined }): RunTone {
  if (x.status === 'in_progress') return 'running';
  if (x.status === 'waiting' || x.conclusion === 'action_required') return 'waiting';
  if (x.status !== 'completed') return 'queued';
  switch (x.conclusion) {
    case 'success':
    case 'neutral':
      return 'passed';
    case 'cancelled':
    case 'stale':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

/** Not finished yet: still worth watching. */
export const isLive = (x: { readonly status: GhRunStatus }): boolean => x.status !== 'completed';

export const TONE_WORDS: Readonly<Record<RunTone, string>> = {
  running: 'Running',
  queued: 'Queued',
  waiting: 'Waiting',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** What a run's status says, a little more exactly than its tone ("Timed out", "Startup failure"). */
export function statusWords(x: { readonly status: GhRunStatus; readonly conclusion?: GhConclusion | undefined }): string {
  if (x.status === 'waiting') return 'Waiting for approval';
  if (x.conclusion === 'timed_out') return 'Timed out';
  if (x.conclusion === 'startup_failure') return 'Startup failure';
  if (x.conclusion === 'action_required') return 'Action required';
  return TONE_WORDS[runTone(x)];
}

/** "push" → "Push", "pull_request" → "Pull request", "workflow_dispatch" → "Manual". */
export function eventWords(event: string): string {
  const known: Record<string, string> = { workflow_dispatch: 'Manual', pull_request: 'Pull request', pull_request_target: 'Pull request', schedule: 'Scheduled', workflow_run: 'After a workflow', workflow_call: 'Called', merge_group: 'Merge queue', repository_dispatch: 'Dispatch', dynamic: 'GitHub' };
  if (known[event]) return known[event];
  const w = event.replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** How long something took (or has taken so far): "42s", "3m 05s", "1h 02m". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** How long a run has taken: from when this attempt started to its last update (or now, while it runs). */
export const runDuration = (run: Pick<GhRun, 'status' | 'startedAt' | 'updatedAt'>, now: number): number => Math.max(0, (isLive(run) ? now : run.updatedAt) - run.startedAt);

/** How long a job or step has taken (undefined before it starts). */
export function spanOf(x: { readonly startedAt?: number | undefined; readonly completedAt?: number | undefined; readonly status: GhRunStatus }, now: number): number | undefined {
  if (!x.startedAt) return undefined;
  const end = x.completedAt || (isLive(x) ? now : x.startedAt);
  return Math.max(0, end - x.startedAt);
}

/** "ci.yml" from ".github/workflows/ci.yml". */
export const fileName = (path: string): string => path.split('@')[0]!.split('/').pop() ?? path;

/** A short commit id. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * How soon to ask GitHub again: often while something runs (it's being watched), seldom
 * otherwise (a new push starts a run you'll want to see).
 */
export const RUNS_LIVE_MS = 5_000;
export const RUNS_IDLE_MS = 45_000;
export const pollEvery = (runs: ReadonlyArray<Pick<GhRun, 'status'>>): number => (runs.some(isLive) ? RUNS_LIVE_MS : RUNS_IDLE_MS);

/** The runs that matter first: running and queued on top, then the newest. */
export function sortRuns<T extends Pick<GhRun, 'status' | 'createdAt'>>(runs: readonly T[]): T[] {
  return [...runs].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.createdAt - a.createdAt);
}

/** The jobs that matter first: failed, then running, then the rest in GitHub's order. */
export function sortJobs(jobs: readonly GhJob[]): GhJob[] {
  const rank = (j: GhJob): number => ({ failed: 0, running: 1, waiting: 2, queued: 3, cancelled: 4, passed: 5, skipped: 6 })[runTone(j)];
  return jobs.map((j, i) => [j, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([j]) => j);
}

/** What a run's jobs add up to: "3 of 5 jobs done", "1 failed". */
export function jobsSummary(jobs: readonly GhJob[]): string {
  if (!jobs.length) return 'No jobs yet';
  const tones = jobs.map(runTone);
  const failed = tones.filter((t) => t === 'failed').length;
  const done = jobs.filter((j) => !isLive(j)).length;
  const parts = [done === jobs.length ? `${jobs.length} job${jobs.length === 1 ? '' : 's'}` : `${done} of ${jobs.length} jobs done`];
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}
