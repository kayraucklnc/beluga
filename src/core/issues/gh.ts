import { execFile } from 'node:child_process';
import { belugaEnv } from '../beluga-env.js';
import type { GhRunner, GitHubRepo } from '../../workspaces/github.js';
import type { GhCloseReason, GhComment, GhIssue, GhIssueFull, GhIssueState, GhLabel, GhPull } from './model.js';

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
  /** The open pull requests, newest activity first, and how many are open. */
  pulls(repo: GitHubRepo): Promise<{ readonly pulls: readonly GhPull[]; readonly total: number }>;
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

/**
 * A repository's open or closed issues, newest activity first, through GraphQL: unlike REST's
 * issues list (where pull requests take up the pages), only issues, and how many there are.
 */
export const ISSUES_QUERY = (state: GhIssueState): string =>
  `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { issues(first: ${ISSUES_PAGE}, states: [${state === 'open' ? 'OPEN' : 'CLOSED'}], orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { number title state stateReason url createdAt updatedAt closedAt author { login } labels(first: 10) { nodes { name color } } assignees(first: 5) { nodes { login } } comments { totalCount } } } } }`;

/** One issue of the GraphQL answer, in Beluga's words. */
export function parseGraphIssue(raw: unknown): GhIssue | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const nodes = (v: unknown): unknown[] => (v && typeof v === 'object' && Array.isArray((v as { nodes?: unknown }).nodes) ? (v as { nodes: unknown[] }).nodes : []);
  const count = (v: unknown): number => (v && typeof v === 'object' && typeof (v as { totalCount?: unknown }).totalCount === 'number' ? (v as { totalCount: number }).totalCount : 0);
  return parseIssue({
    number: r.number,
    title: r.title,
    state: typeof r.state === 'string' ? r.state.toLowerCase() : 'open',
    state_reason: typeof r.stateReason === 'string' ? r.stateReason.toLowerCase() : undefined,
    html_url: r.url,
    user: r.author,
    labels: nodes(r.labels),
    assignees: nodes(r.assignees),
    comments: count(r.comments),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    closed_at: r.closedAt,
  });
}

/** The GraphQL answer's issues, and how many the repository has in that state. */
export function parseGraphIssues(json: string): { readonly issues: GhIssue[]; readonly total: number } {
  const raw = JSON.parse(json) as { data?: { repository?: { issues?: { totalCount?: number; nodes?: unknown[] } } | null }; errors?: Array<{ message?: string }> };
  const list = raw.data?.repository?.issues;
  if (!list || !Array.isArray(list.nodes)) throw new Error(raw.errors?.[0]?.message ?? 'GitHub gave an answer Beluga doesn’t understand');
  const issues = list.nodes.map(parseGraphIssue).filter((i): i is GhIssue => Boolean(i));
  return { issues, total: typeof list.totalCount === 'number' ? list.totalCount : issues.length };
}

/** How many open pull requests one look reads. */
export const PULLS_PAGE = 50;

/** A repository's open pull requests, newest activity first, with their latest commit's checks. */
export const PULLS_QUERY = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { pullRequests(first: ${PULLS_PAGE}, states: [OPEN], orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { number title url isDraft headRefName createdAt updatedAt reviewDecision author { login } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

const CHECKS: Record<string, GhPull['checks']> = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' };
const REVIEWS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);

/** One pull request of the GraphQL answer, in Beluga's words; undefined for nonsense. */
export function parseGraphPull(raw: unknown): GhPull | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.number !== 'number' || typeof r.title !== 'string' || typeof r.url !== 'string') return undefined;
  const commits = (r.commits as { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: unknown } | null } }> } | undefined)?.nodes;
  const rollup = commits?.at(-1)?.commit?.statusCheckRollup?.state;
  const author = login(r.author);
  const review = typeof r.reviewDecision === 'string' && REVIEWS.has(r.reviewDecision) ? (r.reviewDecision as GhPull['review']) : undefined;
  return {
    number: r.number,
    title: r.title.trim() || `Pull request #${r.number}`,
    url: r.url,
    ...(author ? { author } : {}),
    branch: typeof r.headRefName === 'string' ? r.headRefName : '',
    draft: r.isDraft === true,
    checks: (typeof rollup === 'string' && CHECKS[rollup]) || 'none',
    ...(review ? { review } : {}),
    createdAt: at(r.createdAt),
    updatedAt: at(r.updatedAt),
  };
}

/** The GraphQL answer's open pull requests, and how many the repository has open. */
export function parseGraphPulls(json: string): { readonly pulls: GhPull[]; readonly total: number } {
  const raw = JSON.parse(json) as { data?: { repository?: { pullRequests?: { totalCount?: number; nodes?: unknown[] } } | null }; errors?: Array<{ message?: string }> };
  const list = raw.data?.repository?.pullRequests;
  if (!list || !Array.isArray(list.nodes)) throw new Error(raw.errors?.[0]?.message ?? 'GitHub gave an answer Beluga doesn’t understand');
  const pulls = list.nodes.map(parseGraphPull).filter((p): p is GhPull => Boolean(p));
  return { pulls, total: typeof list.totalCount === 'number' ? list.totalCount : pulls.length };
}

/** GitHub's search words for a repository's issues: `repo:o/r is:issue is:open <words>`. */
export const searchQuery = (repo: GitHubRepo, state: GhIssueState, words: string): string => `repo:${repo.owner}/${repo.repo} is:issue is:${state} ${words.replace(/\s+/g, ' ').trim()}`;

/**
 * An issue's latest comments, oldest of them first: REST lists them oldest first, so the last page
 * (and the one before, when the last is short). Nothing when GitHub won't say.
 */
async function latestComments(run: GhRunner, repo: GitHubRepo, path: string, count: number): Promise<GhComment[]> {
  const page = (n: number): Promise<GhComment[]> => run(['api', ...hostArgs(repo), '-X', 'GET', `${path}/comments`, '-f', `per_page=${COMMENTS_PAGE}`, '-f', `page=${n}`]).then(parseComments, () => []);
  const last = Math.max(1, Math.ceil(count / COMMENTS_PAGE));
  const tail = await page(last);
  if (last === 1 || tail.length >= COMMENTS_PAGE / 2) return tail;
  return [...(await page(last - 1)), ...tail];
}

/** The real thing: `gh api` against the repository's host. */
export function ghIssueSource(run: GhRunner = runGhCli): IssueSource {
  return {
    async list(repo, state, search) {
      const words = search?.trim();
      if (!words) {
        const { issues, total } = parseGraphIssues(await run(['api', 'graphql', ...hostArgs(repo), '-f', `query=${ISSUES_QUERY(state)}`, '-f', `owner=${repo.owner}`, '-f', `repo=${repo.repo}`]));
        return { issues, more: total > issues.length };
      }
      // Searching: GitHub's search (is:issue leaves pull requests out), the best matches newest first.
      const out = await run(['api', ...hostArgs(repo), '-X', 'GET', 'search/issues', '-f', `q=${searchQuery(repo, state, words)}`, '-f', 'sort=updated', '-f', `per_page=${ISSUES_PAGE}`]);
      const raw = JSON.parse(out) as { total_count?: unknown };
      const issues = parseIssues(out);
      return { issues, more: typeof raw.total_count === 'number' ? raw.total_count > issues.length : false };
    },
    async get(repo, number) {
      const path = `repos/${repo.owner}/${repo.repo}/issues/${number}`;
      const raw = JSON.parse(await run(['api', ...hostArgs(repo), path])) as Record<string, unknown>;
      if (raw?.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
      const issue = parseIssue(raw);
      if (!issue) throw new Error(`Couldn’t read issue #${number}`);
      const thread = issue.comments ? await latestComments(run, repo, path, issue.comments) : [];
      return { ...issue, body: typeof raw.body === 'string' ? raw.body : '', thread, ...(issue.comments > thread.length ? { moreComments: true } : {}) };
    },
    async comment(repo, number, body) {
      const text = body.trim().slice(0, MAX_COMMENT);
      if (!text) throw new Error('Nothing to post');
      const out = await run(['api', ...hostArgs(repo), '-X', 'POST', `repos/${repo.owner}/${repo.repo}/issues/${number}/comments`, '-f', `body=${text}`]);
      const url = (JSON.parse(out) as { html_url?: unknown }).html_url;
      return typeof url === 'string' ? url : `https://${repo.host}/${repo.owner}/${repo.repo}/issues/${number}`;
    },
    async pulls(repo) {
      return parseGraphPulls(await run(['api', 'graphql', ...hostArgs(repo), '-f', `query=${PULLS_QUERY}`, '-f', `owner=${repo.owner}`, '-f', `repo=${repo.repo}`]));
    },
  };
}
