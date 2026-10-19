import type { CommitRef } from '../../../../../src/workspaces/history.js';

/**
 * History's words and pieces, without React: avatars (initials and a color per person; no
 * network, so no Gravatar), times ("3 h ago", the full date on hover), the ref pills and the
 * branch filter's choices. Tested on its own (tests/mac-history.test.ts).
 */

const AVATAR_COLORS = ['#5b8def', '#3fa776', '#a46ed0', '#d39a2c', '#2fa4a0', '#7f72e6', '#b98a5e', '#5f9ad6', '#c46a8a', '#6a9a4f'];

/** A steady color per author (FNV-1a over the email, else the name). */
export function authorColor(key: string): string {
  let h = 0x811c9dc5;
  const k = key.trim().toLowerCase();
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

/** "Mia Chen" → "MC", "kay" → "K", "dependabot[bot]" → "D". */
export function initials(name: string): string {
  const words = name
    .replace(/\[bot\]$/i, '')
    .split(/[\s._-]+/)
    .filter((w) => /\p{L}|\d/u.test(w));
  if (!words.length) return '?';
  const first = [...words[0]!][0] ?? '';
  const last = words.length > 1 ? ([...words.at(-1)!][0] ?? '') : '';
  return (first + last).toUpperCase();
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 d ago", "3 wk ago", then the date. */
export function timeAgo(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return 'yesterday';
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} d ago`;
  if (d < 35 * DAY) return `${Math.floor(d / (7 * DAY))} wk ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Friday, October 17, 2026 at 14:05" (the tooltip on a time). */
export const fullDate = (ts: number): string => new Date(ts).toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export type PillTone = 'head' | 'branch' | 'remote' | 'tag' | 'worktree' | 'upstream';

export interface Pill {
  readonly label: string;
  readonly tone: PillTone;
  /** A worktree on this branch (its workspace id), to open from the pill. */
  readonly worktree?: { readonly id: string; readonly name: string };
  readonly title: string;
}

const ORDER: Record<PillTone, number> = { head: 0, worktree: 1, branch: 2, upstream: 3, remote: 4, tag: 5 };

/**
 * A commit's refs as pills: HEAD first, then your worktrees' branches (highlighted), local
 * branches, the upstream (origin/main), other remote branches and tags. "main" and
 * "origin/main" on the same commit stay two pills: being level is the point.
 */
export function pillsOf(refs: readonly CommitRef[], ctx: { worktrees?: ReadonlyMap<string, { id: string; name: string }>; upstream?: string; current?: string } = {}): Pill[] {
  const out: Pill[] = refs.map((r): Pill => {
    if (r.kind === 'head') return { label: ctx.current ? `HEAD → ${ctx.current}` : 'HEAD', tone: 'head', title: ctx.current ? `Checked out: ${ctx.current}` : 'Checked out here (detached)' };
    if (r.kind === 'tag') return { label: r.name, tone: 'tag', title: `Tag ${r.name}` };
    if (r.kind === 'remote') return r.name === ctx.upstream ? { label: r.name, tone: 'upstream', title: `${r.name}: as of the last fetch` } : { label: r.name, tone: 'remote', title: `Remote branch ${r.name}` };
    const wt = ctx.worktrees?.get(r.name);
    if (wt) return { label: r.name, tone: 'worktree', worktree: wt, title: `Worktree ${wt.name} (click to open)` };
    return { label: r.name, tone: 'branch', title: `Branch ${r.name}` };
  });
  // HEAD → main says it already: drop the separate "main" pill.
  const shown = ctx.current && out.some((p) => p.tone === 'head') ? out.filter((p) => !(p.tone === 'branch' && p.label === ctx.current)) : out;
  return shown.sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
}

export interface BranchChoice {
  readonly value: string;
  readonly label: string;
}

/** The branch filter: everything, what's checked out (with its upstream), then each branch and tag. */
export function branchChoices(filters: { current?: string; branches: readonly string[]; remotes: readonly string[]; tags: readonly string[] } | undefined): { all: BranchChoice[]; local: BranchChoice[]; remote: BranchChoice[]; tags: BranchChoice[] } {
  const as = (names: readonly string[] = []): BranchChoice[] => names.map((b) => ({ value: b, label: b }));
  return {
    all: [
      { value: 'all', label: 'All Branches' },
      { value: 'current', label: filters?.current ? `Current (${filters.current})` : 'Current (HEAD)' },
    ],
    local: as(filters?.branches),
    remote: as(filters?.remotes),
    tags: as(filters?.tags),
  };
}

/** The plural people expect: "1 commit", "3 commits". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A GitHub page for one commit, from the repository's page. */
export const commitPage = (repoUrl: string, hash: string): string => `${repoUrl.replace(/\/+$/, '')}/commit/${hash}`;
