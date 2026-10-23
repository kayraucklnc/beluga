import type { PullRequest } from '../core/work-store.js';

// Small formatters the app uses.

/** "340 MB", "1.2 GB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}

/** "PR #12 · checks passing" */
export function describePr(pr: PullRequest): string {
  if (pr.state === 'MERGED') return `PR #${pr.number} merged`;
  if (pr.state === 'CLOSED') return `PR #${pr.number} closed`;
  const checks = pr.checks === 'none' ? '' : ` · checks ${pr.checks}`;
  const review = pr.review === 'APPROVED' ? ' · approved' : pr.review === 'CHANGES_REQUESTED' ? ' · changes requested' : '';
  return `PR #${pr.number}${pr.draft ? ' (draft)' : ''}${checks}${review}`;
}
