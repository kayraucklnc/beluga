import type { PrCheck, PullRequest } from '@beluga/core/work-store.js';
import type { MergeMethod } from '@beluga/workspaces/pr.js';

/** How one check is doing, as the PR sheet draws it: a spinner, a clock, ✓, ✗ or a dash. */
export type CheckTone = 'running' | 'queued' | 'passed' | 'failed' | 'skipped';

const FAILED = new Set(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
const SKIPPED = new Set(['skipped', 'neutral', 'stale']);

export function checkTone(c: PrCheck): CheckTone {
  if (c.state === 'in_progress') return 'running';
  if (c.state === 'queued') return 'queued';
  if (c.conclusion && FAILED.has(c.conclusion)) return 'failed';
  if (c.conclusion && SKIPPED.has(c.conclusion)) return 'skipped';
  return 'passed';
}

const ORDER: Record<CheckTone, number> = { failed: 0, running: 1, queued: 2, passed: 3, skipped: 4 };

/** Failed first, then running, waiting, passed and skipped (each in GitHub's order). */
export function sortChecks(checks: readonly PrCheck[]): PrCheck[] {
  return checks.map((c, i) => ({ c, i })).sort((a, b) => ORDER[checkTone(a.c)] - ORDER[checkTone(b.c)] || a.i - b.i).map(({ c }) => c);
}

/** "42s", "3m 05s", "1h 02m": how long it ran, or has been running (`now`). Empty when unknown. */
export function checkDuration(c: PrCheck, now: number): string {
  if (checkTone(c) === 'skipped') return 'Skipped';
  const start = c.startedAt ? Date.parse(c.startedAt) : NaN;
  const end = c.completedAt ? Date.parse(c.completedAt) : c.state === 'in_progress' ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "3 of 5 passed · 1 running". */
export function checksSummary(checks: readonly PrCheck[]): string {
  const n = { running: 0, queued: 0, passed: 0, failed: 0, skipped: 0 };
  for (const c of checks) n[checkTone(c)]++;
  const counted = checks.length - n.skipped;
  return [`${n.passed} of ${counted} passed`, n.failed ? `${n.failed} failed` : '', n.running + n.queued ? `${n.running + n.queued} running` : ''].filter(Boolean).join(' · ');
}

export const MERGE_METHODS: ReadonlyArray<{ readonly method: MergeMethod; readonly label: string; readonly hint: string }> = [
  { method: 'squash', label: 'Squash and Merge', hint: 'One commit on the base branch' },
  { method: 'merge', label: 'Create a Merge Commit', hint: 'Every commit, joined by a merge commit' },
  { method: 'rebase', label: 'Rebase and Merge', hint: 'Every commit, replayed on the base branch' },
];

/** Whether "Merge When Checks Pass" makes sense: something is still to come (checks or a review). */
export const canAutoMerge = (pr: PullRequest): boolean => pr.state === 'OPEN' && !pr.autoMerge && (pr.checks === 'pending' || pr.review === 'REVIEW_REQUIRED');

/** Whether "Merge Now, Skipping Checks" makes sense: checks or a review stand in the way (a conflict can't be skipped). */
export const canSkipChecks = (pr: PullRequest): boolean => pr.state === 'OPEN' && !pr.draft && !pr.conflicts && (pr.checks === 'pending' || pr.checks === 'failing' || pr.review === 'REVIEW_REQUIRED' || pr.review === 'CHANGES_REQUESTED');
