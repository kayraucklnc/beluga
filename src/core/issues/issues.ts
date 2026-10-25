import { type Issue, type IssueGitHub, isFinished, isOpen } from '../board/model.js';
import type { BoardWork } from '../board/work.js';
import type { Store } from '../store.js';
import type { GitHubRepo } from '../../workspaces/github.js';
import type { Workspace } from '../../workspaces/types.js';
import type { IssueSource } from './gh.js';
import { type GhIssueFull, type IssuesList, type IssuesQuery, boardLabels, repoSlug, taskForIssue } from './model.js';
import { fixAfterInvestigationPrompt, fixPrompt, investigatePrompt, issueAsRequest, issueBrief } from './prompts.js';

/**
 * A project's GitHub issues at work in Beluga. Read them (through gh, a minute's cache), and
 * hand one to Claude, always through a task on the board, so it shows where everything else does
 * and its pull request moves it along:
 *  - Investigate: a task and its worktree, Claude finding out why and reproducing it, writing what
 *    it found into the task's brief, and stopping before any fix;
 *  - Fix It: Claude fixing it there (after an investigation, in the same worktree and conversation)
 *    and opening a pull request with "Fixes #n", so merging it closes the issue and the task;
 *  - Make a Task: on the board, written by Claude from the issue, or after a quick read-only look
 *    at the code.
 * One task per issue: asking again works on the one that's there.
 */

/** Issues read a moment ago are shown again rather than asked for (Refresh asks). */
export const LIST_TTL_MS = 60_000;

export interface GitHubIssuesDeps {
  readonly store: Store;
  readonly work: BoardWork;
  /** Where a project is on GitHub, from its remote (undefined: it isn't). */
  readonly repoOf: (projectId: string) => Promise<GitHubRepo | undefined>;
  /** gh is only asked about github.com and hosts it's signed in to (a token never goes to a look-alike host). */
  readonly knownHost?: (host: string) => boolean;
  /** gh is installed and signed in to this host (asked when reading fails, to tell why). */
  readonly ghReady: (host: string) => Promise<boolean>;
  readonly source: IssueSource;
  /** Ask your Claude in a conversation (`ws:<id>`). */
  readonly askClaude: (prompt: string, channel: string) => void;
  /** How a worktree's pull request is opened: the user's PR instructions, filled in for it. */
  readonly prPrompt: (ws: Workspace) => string;
  readonly now?: () => number;
}

/** What starting work on an issue gives: its task, and the worktree Claude works in. */
export interface IssueWork {
  readonly task: string;
  readonly key: string;
  readonly ws?: string;
}

export class GitHubIssues {
  private readonly lists = new Map<string, { readonly at: number; readonly list: IssuesList }>();
  private readonly full = new Map<string, { readonly at: number; readonly issue: GhIssueFull }>();

  constructor(private readonly deps: GitHubIssuesDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async repo(projectId: string): Promise<GitHubRepo> {
    if (!this.deps.store.getState().projects.some((p) => p.id === projectId && p.root)) throw new Error('That project is gone');
    const repo = await this.deps.repoOf(projectId);
    if (!repo) throw new Error('This project isn’t on GitHub');
    if (this.deps.knownHost && !this.deps.knownHost(repo.host)) throw new Error(`Sign in to ${repo.host} with gh first (gh auth login --hostname ${repo.host})`);
    return repo;
  }

  /** A project's open (or closed) issues, newest activity first; a search narrows them. */
  async list(projectId: string, query: IssuesQuery = {}): Promise<IssuesList> {
    const state = query.state ?? 'open';
    const search = query.search?.replace(/\s+/g, ' ').trim() ?? '';
    const key = `${projectId}\0${state}\0${search}`;
    const kept = this.lists.get(key);
    if (kept && !query.force && this.now() - kept.at < LIST_TTL_MS) return kept.list;
    if (!this.deps.store.getState().projects.some((p) => p.id === projectId && p.root)) return { kind: 'none' };
    const repo = await this.deps.repoOf(projectId);
    if (!repo) return { kind: 'none' };
    if (this.deps.knownHost && !this.deps.knownHost(repo.host)) return { kind: 'no_gh', repo };
    let list: IssuesList;
    try {
      const { issues, more } = await this.deps.source.list(repo, state, search || undefined);
      list = { kind: 'github', repo, issues, more, fetchedAt: this.now() };
    } catch (err) {
      if (!(await this.deps.ghReady(repo.host).catch(() => false))) return { kind: 'no_gh', repo };
      return { kind: 'error', repo, message: ghWords(err, repo) };
    }
    this.lists.set(key, { at: this.now(), list });
    return list;
  }

  /** One issue in full (its comments too), and the repository it's in. */
  async get(projectId: string, number: number, force = false): Promise<{ readonly repo: GitHubRepo; readonly issue: GhIssueFull }> {
    const repo = await this.repo(projectId);
    const key = `${projectId}\0${number}`;
    const kept = this.full.get(key);
    if (kept && !force && this.now() - kept.at < LIST_TTL_MS) return { repo, issue: kept.issue };
    try {
      const issue = await this.deps.source.get(repo, number);
      this.full.set(key, { at: this.now(), issue });
      return { repo, issue };
    } catch (err) {
      if (!(await this.deps.ghReady(repo.host).catch(() => false))) throw new Error('Connect GitHub first: install gh and sign in (brew install gh, then gh auth login)');
      throw new Error(ghWords(err, repo));
    }
  }

  /** Investigate: Claude finds out why it happens and reproduces it, in the task's worktree, without fixing it. */
  async investigate(projectId: string, number: number): Promise<IssueWork> {
    const { repo, issue } = await this.get(projectId, number);
    const task = this.ensureTask(projectId, repo, issue);
    const ws = await this.workOn(task, 'investigate', (t) => investigatePrompt(t, issue, repo), `asked Claude to investigate #${number}`);
    return { task: task.id, key: task.key, ws };
  }

  /**
   * Fix It: Claude fixes it and opens a pull request that closes the issue. After an investigation
   * that's in the same worktree, with what it found; otherwise in a new one.
   */
  async fix(projectId: string, number: number): Promise<IssueWork> {
    const { repo, issue } = await this.get(projectId, number);
    const task = this.ensureTask(projectId, repo, issue);
    const ws = await this.workOn(task, 'fix', (t, w, here) => (here ? fixAfterInvestigationPrompt(t, issue, this.deps.prPrompt(w)) : fixPrompt(t, issue, repo, this.deps.prPrompt(w))), `asked Claude to fix #${number}`);
    return { task: task.id, key: task.key, ws };
  }

  /**
   * Make a Task: on the board as Ready, written by your Claude from the issue (`look`: after a
   * quick read-only look at the code, so it also says where the code is and what's likely behind it).
   */
  async toTask(projectId: string, number: number, opts: { readonly look?: boolean } = {}): Promise<IssueWork> {
    const { repo, issue } = await this.get(projectId, number);
    const there = taskForIssue(this.deps.work.board.state(), projectId, repo, number);
    if (there) return { task: there.id, key: there.key };
    const root = this.deps.store.getState().projects.find((p) => p.id === projectId)?.root;
    const task = this.deps.work.createDescribed({ projectId, status: 'todo', labels: boardLabels(issue.labels), github: link(repo, issue) }, issueAsRequest(issue), { origin: 'github', ...(opts.look && root ? { look: root } : {}) });
    return { task: task.id, key: task.key };
  }

  /** Post a comment on the issue as you (what Claude found, say). → its URL. */
  async comment(projectId: string, number: number, body: string): Promise<string> {
    const repo = await this.repo(projectId);
    try {
      const url = await this.deps.source.comment(repo, number, body);
      this.full.delete(`${projectId}\0${number}`);
      return url;
    } catch (err) {
      throw new Error(ghWords(err, repo));
    }
  }

  /** The issue's task: the one on the board, else a new one (Ready, its report as context, to be worked on now). */
  private ensureTask(projectId: string, repo: GitHubRepo, issue: GhIssueFull): Issue {
    const work = this.deps.work;
    const there = taskForIssue(work.board.state(), projectId, repo, issue.number);
    if (there) {
      if (isFinished(there.status) || !isOpen(there.status)) throw new Error(`${there.key} is ${there.status === 'canceled' ? 'canceled' : there.status === 'done' ? 'done' : 'in review'}: reopen it on its page to work on #${issue.number} again`);
      return there;
    }
    return work.board.create({ projectId, title: issue.title, status: 'todo', labels: boardLabels(issue.labels), brief: issueBrief(issue), github: link(repo, issue) }, work.me(), 'github');
  }

  /**
   * Claude on the task: in its worktree when it has one still there (`here`: Claude knows the issue
   * already), else in a new one started for it. The task says what Claude was asked last.
   */
  private async workOn(task: Issue, step: NonNullable<IssueGitHub['step']>, prompt: (task: Issue, ws: Workspace, here: boolean) => string, note: string): Promise<string> {
    const work = this.deps.work;
    const live = this.liveWorktree(task);
    work.board.setGitHub(task.id, { ...task.github!, step }, work.me(), note);
    if (live) {
      const now = work.board.need(task.id);
      if (now.status === 'backlog' || now.status === 'todo') work.board.update(now.id, { status: 'in_progress' }, work.me());
      this.deps.askClaude(prompt(work.board.need(task.id), live, true), `ws:${live.id}`);
      return live.id;
    }
    try {
      // Quiet: you stay on the issue (its page shows Claude at work, a click from the conversation).
      return await work.start(task.id, { quiet: true, prompt: (t, ws) => prompt(t, ws, false) });
    } catch (err) {
      // Nothing started: the task says what it said before.
      work.board.setGitHub(task.id, task.github, work.me());
      throw err;
    }
  }

  /** The worktree doing a task, if it's still there. */
  private liveWorktree(task: Issue): Workspace | undefined {
    const all = this.deps.store.getState().projects.flatMap((p) => p.workspaces);
    for (const id of [task.carriedBy, task.worktrees.at(-1)]) {
      const ws = id ? all.find((w) => w.id === id && !w.archived && w.kind === 'worktree') : undefined;
      if (ws) return ws;
    }
    return undefined;
  }
}

const link = (repo: GitHubRepo, issue: GhIssueFull): IssueGitHub => ({ repo: repoSlug(repo), ...(repo.host === 'github.com' ? {} : { host: repo.host }), number: issue.number, url: issue.url || `${repo.url}/issues/${issue.number}` });

/** What gh said, in Beluga's words (gh's messages never hold a token, but they can be long). */
export function ghWords(err: unknown, repo: GitHubRepo): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/HTTP 404|Not Found|Could not resolve to a Repository/i.test(raw)) return `GitHub can’t find that in ${repo.owner}/${repo.repo}, or your account can’t see it`;
  if (/HTTP 410|issues are disabled|has disabled issues/i.test(raw)) return `${repo.owner}/${repo.repo} has issues turned off on GitHub`;
  if (/rate limit|HTTP 429|secondary rate/i.test(raw)) return 'GitHub asked Beluga to slow down: try again in a minute';
  if (/HTTP 401|authentication|auth login|not logged in/i.test(raw)) return 'GitHub doesn’t accept your sign-in any more: run gh auth login in Terminal';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timeout|could not connect/i.test(raw)) return 'Couldn’t reach GitHub: check your connection and try again';
  const line = raw.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line ? `GitHub said: ${line.slice(0, 200)}` : 'GitHub didn’t answer';
}
