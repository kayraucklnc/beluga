import { execFile } from 'node:child_process';
import { belugaEnv } from '../beluga-env.js';
import type { GhRunner, GitHubRepo } from '../../workspaces/github.js';
import type { GhCloseReason, GhComment, GhIssue, GhIssueFull, GhIssueState, GhLabel } from './model.js';

/**
 * A repository's issues through the GitHub CLI (`gh api`), with the sign-in people already have:
 * the open or closed ones (newest activity first), a search, one issue with its comments, and a
 * comment from you. Pull requests (which GitHub lists as issues too) are left out.
 */

/** How many issues one look reads (a search narrows it). */
export const ISSUES_PAGE = 100;
/** How many comments an issue's page reads. */
export const COMMENTS_PAGE = 100;
/** The longest comment Beluga posts. */
export const MAX_COMMENT = 60_000;

/** The GitHub CLI: `gh`, or BELUGA_GH (the Mac app's end-to-end tests point it at a stand-in). */
export const runGhCli: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(belugaEnv('GH') || 'gh', [...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });

/** Where a repository's issues are, for anything that reads or writes them. */
export interface IssueSource {
  list(repo: GitHubRepo, state: GhIssueState, search?: string): Promise<{ readonly issues: readonly GhIssue[]; readonly more: boolean }>;
  get(repo: GitHubRepo, number: number): Promise<GhIssueFull>;
  /** Post a comment; → its URL. */
  comment(repo: GitHubRepo, number: number, body: string): Promise<string>;
}

const hostArgs = (repo: GitHubRepo): string[] => (repo.host === 'github.com' ? [] : ['--hostname', repo.host]);
const at = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) || 0 : 0);
const login = (u: unknown): string | undefined => (u && typeof u === 'object' && typeof (u as { login?: unknown }).login === 'string' ? (u as { login: string }).login : undefined);

const REASONS: Record<string, GhCloseReason> = { completed: 'completed', not_planned: 'not_planned', duplicate: 'duplicate' };

/** One issue of GitHub's REST answer, in Beluga's words; undefined for a pull request or nonsense. */
export function parseIssue(raw: unknown): GhIssue | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.pull_request || typeof r.number !== 'number' || typeof r.title !== 'string') return undefined;
  const labels: GhLabel[] = Array.isArray(r.labels)
    ? r.labels.flatMap((l): GhLabel[] => {
        if (typeof l === 'string') return [{ name: l, color: '' }];
        const o = l as { name?: unknown; color?: unknown };
        return typeof o?.name === 'string' ? [{ name: o.name, color: typeof o.color === 'string' && /^[0-9a-f]{6}$/i.test(o.color) ? o.color.toLowerCase() : '' }] : [];
      })
    : [];
  const state: GhIssueState = r.state === 'closed' ? 'closed' : 'open';
  const reason = state === 'closed' && typeof r.state_reason === 'string' ? REASONS[r.state_reason] : undefined;
  const author = login(r.user);
  return {
    number: r.number,
    title: r.title.trim() || `Issue #${r.number}`,
    state,
    ...(reason ? { reason } : {}),
    url: typeof r.html_url === 'string' ? r.html_url : '',
    ...(author ? { author } : {}),
    labels,
    assignees: Array.isArray(r.assignees) ? r.assignees.map(login).filter((a): a is string => Boolean(a)) : [],
    comments: typeof r.comments === 'number' ? r.comments : 0,
    createdAt: at(r.created_at),
    updatedAt: at(r.updated_at),
    ...(state === 'closed' && r.closed_at ? { closedAt: at(r.closed_at) } : {}),
  };
}

/** A list of issues (the issues endpoint's array, or a search's `items`), pull requests left out. */
export function parseIssues(json: string): GhIssue[] {
  const raw = JSON.parse(json) as unknown;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : undefined;
  if (!list) throw new Error('GitHub gave an answer Beluga doesn’t understand');
  return list.map(parseIssue).filter((i): i is GhIssue => Boolean(i));
}

export function parseComments(json: string): GhComment[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c): GhComment[] => {
    const o = c as Record<string, unknown>;
    if (!o || typeof o.body !== 'string') return [];
    const author = login(o.user);
    return [{ ...(author ? { author } : {}), body: o.body, createdAt: at(o.created_at), url: typeof o.html_url === 'string' ? o.html_url : '' }];
  });
}

/** GitHub's search words for a repository's issues: `repo:o/r is:issue is:open <words>`. */
export const searchQuery = (repo: GitHubRepo, state: GhIssueState, words: string): string => `repo:${repo.owner}/${repo.repo} is:issue is:${state} ${words.replace(/\s+/g, ' ').trim()}`;

/** The real thing: `gh api` against the repository's host. */
export function ghIssueSource(run: GhRunner = runGhCli): IssueSource {
  return {
    async list(repo, state, search) {
      const words = search?.trim();
      const out = words
        ? await run(['api', ...hostArgs(repo), '-X', 'GET', 'search/issues', '-f', `q=${searchQuery(repo, state, words)}`, '-f', 'sort=updated', '-f', `per_page=${ISSUES_PAGE}`])
        : await run(['api', ...hostArgs(repo), '-X', 'GET', `repos/${repo.owner}/${repo.repo}/issues`, '-f', `state=${state}`, '-f', 'sort=updated', '-f', 'direction=desc', '-f', `per_page=${ISSUES_PAGE}`]);
      const raw = JSON.parse(out) as unknown;
      // A full page (pull requests count towards it): there are probably more.
      const read = Array.isArray(raw) ? raw.length : ((raw as { items?: unknown[] }).items?.length ?? 0);
      const total = !Array.isArray(raw) && typeof (raw as { total_count?: unknown }).total_count === 'number' ? (raw as { total_count: number }).total_count : undefined;
      const issues = parseIssues(out);
      return { issues, more: total !== undefined ? total > issues.length : read >= ISSUES_PAGE };
    },
    async get(repo, number) {
      const path = `repos/${repo.owner}/${repo.repo}/issues/${number}`;
      const raw = JSON.parse(await run(['api', ...hostArgs(repo), path])) as Record<string, unknown>;
      if (raw?.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
      const issue = parseIssue(raw);
      if (!issue) throw new Error(`Couldn’t read issue #${number}`);
      const thread = issue.comments ? await run(['api', ...hostArgs(repo), '-X', 'GET', `${path}/comments`, '-f', `per_page=${COMMENTS_PAGE}`]).then(parseComments, () => []) : [];
      return { ...issue, body: typeof raw.body === 'string' ? raw.body : '', thread, ...(issue.comments > thread.length ? { moreComments: true } : {}) };
    },
    async comment(repo, number, body) {
      const text = body.trim().slice(0, MAX_COMMENT);
      if (!text) throw new Error('Nothing to post');
      const out = await run(['api', ...hostArgs(repo), '-X', 'POST', `repos/${repo.owner}/${repo.repo}/issues/${number}/comments`, '-f', `body=${text}`]);
      const url = (JSON.parse(out) as { html_url?: unknown }).html_url;
      return typeof url === 'string' ? url : `https://${repo.host}/${repo.owner}/${repo.repo}/issues/${number}`;
    },
  };
}
