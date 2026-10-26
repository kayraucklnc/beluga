import type { GhRunner, GitHubRepo } from '../../../workspaces/github.js';
import type { GitHubTrigger } from '../model.js';
import { MINUTE, type TriggerContext, type TriggerDeps, type TriggerEvent, clip, isObj, num, remember, startPolling, str, time } from './types.js';

/**
 * GitHub (docs/sentinel.md §1): the project's repository, polled with gh every `minutes` (2 by
 * default, at least 1): an issue opens, an issue gets a label, a pull request opens, a workflow
 * fails, a deployment fails. The cursor is the newest time seen and the ids seen lately; the first
 * look only notes where things are (nothing old fires). No gh, signed out, or not on GitHub: the
 * page says so and it looks again in 10 minutes.
 */

export interface GitHubCursor {
  /** The newest time GitHub gave (its clock, ms). */
  readonly since: number;
  /** Ids seen lately ("i12" an issue, "p7" a pull request, "e…" a label event, "r…" a run, "s…" a deployment status). */
  readonly seen: readonly string[];
}

/** Things a few minutes older than the cursor are still looked at (GitHub's lists lag a little); `seen` keeps them from firing twice. */
const OVERLAP_MS = 5 * MINUTE;

const repoPath = (r: GitHubRepo): string => `repos/${r.owner}/${r.repo}`;
const hostArgs = (r: GitHubRepo): string[] => (r.host && r.host !== 'github.com' ? ['--hostname', r.host] : []);
const login = (u: unknown): string | undefined => (isObj(u) ? str(u.login) : undefined);
const labelsOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((l) => (typeof l === 'string' ? [l] : isObj(l) && typeof l.name === 'string' ? [l.name] : [])) : []);

async function api(gh: GhRunner, repo: GitHubRepo, path: string): Promise<unknown> {
  const out = await gh(['api', ...hostArgs(repo), path]);
  try {
    return JSON.parse(out) as unknown;
  } catch {
    throw new Error('GitHub gave an answer Beluga doesn’t understand');
  }
}

const list = (v: unknown, key?: string): unknown[] => (Array.isArray(v) ? v : key && isObj(v) && Array.isArray(v[key]) ? (v[key] as unknown[]) : []);

interface Seen {
  readonly id: string;
  readonly at: number;
  readonly event?: () => Promise<TriggerEvent | undefined>;
}

const issueOf = (r: Record<string, unknown>) => ({ number: num(r.number), title: str(r.title) ?? '', url: str(r.html_url), author: login(r.user), labels: labelsOf(r.labels) });

/** What GitHub has now for this trigger, newest first (each with how to make its event). */
async function items(t: GitHubTrigger, repo: GitHubRepo, gh: GhRunner): Promise<Seen[]> {
  const base = repoPath(repo);
  switch (t.what) {
    case 'issue-opened':
      return list(await api(gh, repo, `${base}/issues?state=all&sort=created&direction=desc&per_page=30`))
        .filter((r): r is Record<string, unknown> => isObj(r) && !r.pull_request && typeof r.number === 'number')
        .map((r) => {
          const issue = issueOf(r);
          return { id: `i${issue.number}`, at: time(r.created_at), event: async () => ({ summary: `GitHub: issue #${issue.number} opened: ${clip(issue.title, 90)}`, payload: { event: 'issue-opened', repo: `${repo.owner}/${repo.repo}`, ...issue, body: clip(str(r.body) ?? '', 2000) } }) };
        });
    case 'issue-labelled': {
      const want = t.label?.trim().toLowerCase();
      return list(await api(gh, repo, `${base}/issues/events?per_page=50`))
        .filter((e): e is Record<string, unknown> => isObj(e) && e.event === 'labeled' && isObj(e.issue) && !(e.issue as Record<string, unknown>).pull_request)
        .filter((e) => !want || (isObj(e.label) && String(e.label.name ?? '').toLowerCase() === want))
        .map((e) => {
          const issue = issueOf(e.issue as Record<string, unknown>);
          const label = isObj(e.label) ? (str(e.label.name) ?? '') : '';
          return { id: `e${String(e.id)}`, at: time(e.created_at), event: async () => ({ summary: `GitHub: issue #${issue.number} got the label “${label}”: ${clip(issue.title, 80)}`, payload: { event: 'issue-labelled', repo: `${repo.owner}/${repo.repo}`, label, by: login(e.actor), ...issue } }) };
        });
    }
    case 'pr-opened':
      return list(await api(gh, repo, `${base}/pulls?state=all&sort=created&direction=desc&per_page=30`))
        .filter((r): r is Record<string, unknown> => isObj(r) && typeof r.number === 'number')
        .map((r) => {
          const pr = { ...issueOf(r), branch: isObj(r.head) ? str(r.head.ref) : undefined, base: isObj(r.base) ? str(r.base.ref) : undefined, draft: r.draft === true };
          return { id: `p${pr.number}`, at: time(r.created_at), event: async () => ({ summary: `GitHub: pull request #${pr.number} opened: ${clip(pr.title, 90)}`, payload: { event: 'pr-opened', repo: `${repo.owner}/${repo.repo}`, ...pr } }) };
        });
    case 'workflow-failed':
      return list(await api(gh, repo, `${base}/actions/runs?status=failure&per_page=20`), 'workflow_runs')
        .filter((r): r is Record<string, unknown> => isObj(r) && r.id !== undefined)
        .map((r) => ({ id: `r${String(r.id)}`, at: time(r.updated_at) || time(r.created_at), event: () => workflowEvent(r, repo, gh) }));
    case 'deployment-failed': {
      // The latest few deployments' latest status says how each went (a status id is seen once).
      const deps = list(await api(gh, repo, `${base}/deployments?per_page=5`)).filter((d): d is Record<string, unknown> => isObj(d) && d.id !== undefined);
      const out: Seen[] = [];
      for (const d of deps) {
        const s = list(await api(gh, repo, `${base}/deployments/${String(d.id)}/statuses?per_page=1`)).find(isObj);
        if (!s || s.id === undefined) continue;
        const env = str(d.environment) ?? 'production';
        const failed = s.state === 'failure' || s.state === 'error';
        out.push({
          id: `s${String(s.id)}`,
          at: time(s.created_at) || time(d.updated_at),
          ...(failed
            ? {
                event: async () => ({
                  summary: `GitHub: the ${env} deployment of ${str(d.ref) ?? 'a commit'} failed`,
                  payload: { event: 'deployment-failed', repo: `${repo.owner}/${repo.repo}`, environment: env, ref: str(d.ref), sha: str(d.sha), state: s.state, description: clip(str(s.description) ?? '', 500), url: str(s.log_url) ?? str(s.target_url) ?? str(s.environment_url), creator: login(d.creator) },
                }),
              }
            : {}),
        });
      }
      return out;
    }
  }
}

/** A failed workflow run: its jobs that failed, each one's first failing step, and the first failed job's log tail. */
async function workflowEvent(r: Record<string, unknown>, repo: GitHubRepo, gh: GhRunner): Promise<TriggerEvent> {
  const name = str(r.name) ?? str(r.display_title) ?? 'A workflow';
  const branch = str(r.head_branch);
  let failed: Array<{ job: string; step?: string; url?: string }> = [];
  let log: string | undefined;
  try {
    const jobs = list(await api(gh, repo, `${repoPath(repo)}/actions/runs/${String(r.id)}/jobs?filter=latest&per_page=50`), 'jobs').filter(isObj);
    const bad = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out' || j.conclusion === 'cancelled');
    failed = bad.map((j) => {
      const step = list(j.steps).find((st) => isObj(st) && st.conclusion === 'failure') as Record<string, unknown> | undefined;
      return { job: str(j.name) ?? 'a job', ...(step && str(step.name) ? { step: str(step.name)! } : {}), ...(str(j.html_url) ? { url: str(j.html_url)! } : {}) };
    });
    const first = bad[0];
    if (first?.id !== undefined) {
      const text = await gh(['api', ...hostArgs(repo), `${repoPath(repo)}/actions/jobs/${String(first.id)}/logs`]).catch(() => '');
      // The tail: where a failing step says why (timestamps off, 60 lines, 4 KB at most).
      const lines = text.split('\n').map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')).filter((l) => l.trim());
      const tail = lines.slice(-60).join('\n');
      if (tail) log = tail.length > 4000 ? tail.slice(-4000) : tail;
    }
  } catch {
    // The run alone says enough.
  }
  const where = failed[0] ? `: ${failed[0].job}${failed[0].step ? ` › ${failed[0].step}` : ''}` : '';
  return {
    summary: clip(`GitHub: workflow ${name} failed${branch ? ` on ${branch}` : ''}${where}`, 140),
    payload: { event: 'workflow-failed', repo: `${repo.owner}/${repo.repo}`, workflow: name, run: num(r.id), number: num(r.run_number), branch, sha: str(r.head_sha), url: str(r.html_url), event_name: str(r.event), actor: login(r.actor), title: str(r.display_title), failed, ...(log ? { log } : {}) },
  };
}

/**
 * One look: what's new since the cursor fires (oldest first), and the cursor moves. → the events and the new cursor.
 * Without a cursor (the first look) nothing fires: it only notes where things are.
 */
export async function lookGitHub(t: GitHubTrigger, repo: GitHubRepo, cursor: GitHubCursor | undefined, gh: GhRunner, now: number): Promise<{ readonly events: TriggerEvent[]; readonly cursor: GitHubCursor }> {
  const found = await items(t, repo, gh);
  const newest = found.reduce((m, f) => Math.max(m, f.at), 0);
  if (!cursor) return { events: [], cursor: { since: newest || now, seen: remember([], found.map((f) => f.id)) } };
  const seen = new Set(cursor.seen);
  const fresh = found.filter((f) => !seen.has(f.id) && f.at >= cursor.since - OVERLAP_MS).sort((a, b) => a.at - b.at);
  const events: TriggerEvent[] = [];
  for (const f of fresh) {
    const e = await f.event?.();
    if (e) events.push(e);
  }
  return { events, cursor: { since: Math.max(cursor.since, newest), seen: remember(cursor.seen, fresh.map((f) => f.id)) } };
}

/** gh's own trouble in words with what to do (none: a blip, tried again later). */
export function ghTrouble(err: unknown): string | undefined {
  const text = err instanceof Error ? err.message : String(err);
  if (/ENOENT|command not found|not found: gh|spawn gh/i.test(text)) return 'GitHub needs the gh command: brew install gh, then gh auth login';
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(text)) return 'Sign in to GitHub first: run gh auth login in a terminal';
  if (/HTTP 404|Not Found/i.test(text)) return 'GitHub doesn’t show this repository to you (gh is signed in as someone else, or it moved)';
  if (/HTTP 403|Resource not accessible/i.test(text)) return 'GitHub says gh may not read this (its sign-in needs the repo and workflow scopes: gh auth refresh -s repo,workflow)';
  return undefined;
}

export const githubEvery = (t: GitHubTrigger): number => Math.max(1, Math.round(t.minutes ?? 2)) * MINUTE;

export function startGitHub(t: GitHubTrigger, ctx: TriggerContext<GitHubCursor>, deps: TriggerDeps): () => void {
  const now = deps.now ?? Date.now;
  return startPolling(
    ctx,
    async () => {
      const gh = deps.gh;
      if (!gh || !deps.repoOf) return 'GitHub needs the Beluga app';
      const projectId = ctx.sentinel.projectId;
      if (!projectId) return 'Pick the project whose GitHub this watches (Project, on the right)';
      const repo = await deps.repoOf(projectId).catch(() => undefined);
      if (!repo) return 'This project isn’t on GitHub: its main folder has no GitHub remote';
      try {
        const { events, cursor } = await lookGitHub(t, repo, ctx.cursor(), gh, now());
        ctx.save(cursor);
        for (const e of events) ctx.fire(e);
        return undefined;
      } catch (err) {
        const trouble = ghTrouble(err);
        if (trouble) return trouble;
        throw err;
      }
    },
    { everyMs: githubEvery(t), failing: 'GitHub didn’t answer' },
  );
}
