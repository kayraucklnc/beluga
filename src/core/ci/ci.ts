import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../store.js';
import type { GitHubRepo } from '../../workspaces/github.js';
import { ghWords } from '../issues/issues.js';
import type { CiSource } from './gh.js';
import { type GhRunFull, type GhWorkflow, type RunsList, type RunsQuery, isLive } from './model.js';

/**
 * A project's GitHub Actions in Beluga: its latest runs, one run's jobs and steps as they go,
 * the workflow file it ran, the project's workflows (their files read from its folder first:
 * fast, and what you're editing), a failed job's log, and re-running or cancelling a run.
 * Read through gh and kept a few seconds, so every screen watching a run asks GitHub once.
 */

/** A running run's state is asked for again after this long (the screens poll a little slower). */
export const LIVE_TTL_MS = 3_000;
/** A list where nothing runs: a push starts something you'll want soon. */
export const IDLE_TTL_MS = 30_000;
/** A finished run doesn't change (a re-run forgets it). */
export const DONE_TTL_MS = 10 * 60_000;
/** Workflow files (on disk they're read again each time). */
export const WORKFLOWS_TTL_MS = 60_000;
/** The longest workflow file Beluga reads. */
const MAX_FILE = 512 * 1024;

export interface GitHubCiDeps {
  readonly store: Store;
  readonly repoOf: (projectId: string) => Promise<GitHubRepo | undefined>;
  readonly knownHost?: (host: string) => boolean;
  readonly ghReady: (host: string) => Promise<boolean>;
  readonly source: CiSource;
  /** Read the project's own workflow files (off for the demo, whose folders aren't its GitHub). */
  readonly localFiles?: boolean;
  readonly now?: () => number;
}

export class GitHubCi {
  private readonly lists = new Map<string, { readonly at: number; readonly list: RunsList }>();
  private readonly runs = new Map<string, { readonly at: number; readonly run: GhRunFull }>();
  /** A file at a commit never changes. */
  private readonly files = new Map<string, string | undefined>();
  private readonly flows = new Map<string, { readonly at: number; readonly flows: readonly GhWorkflow[] }>();
  /** The same question asked by two screens at once is one question to GitHub. */
  private readonly asking = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: GitHubCiDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private once<T>(key: string, job: () => Promise<T>): Promise<T> {
    const going = this.asking.get(key);
    if (going) return going as Promise<T>;
    const p = job().finally(() => this.asking.delete(key));
    this.asking.set(key, p);
    return p;
  }

  private root(projectId: string): string | undefined {
    return this.deps.store.getState().projects.find((p) => p.id === projectId && p.root)?.root;
  }

  private async repo(projectId: string): Promise<GitHubRepo> {
    if (!this.root(projectId)) throw new Error('That project is gone');
    const repo = await this.deps.repoOf(projectId);
    if (!repo) throw new Error('This project isn’t on GitHub');
    if (this.deps.knownHost && !this.deps.knownHost(repo.host)) throw new Error(`Sign in to ${repo.host} with gh first (gh auth login --hostname ${repo.host})`);
    return repo;
  }

  private async words(err: unknown, repo: GitHubRepo): Promise<string> {
    if (!(await this.deps.ghReady(repo.host).catch(() => false))) return 'Connect GitHub first: install gh and sign in (brew install gh, then gh auth login)';
    return ghWords(err, repo);
  }

  /** A project's latest workflow runs, newest first (one workflow's or one branch's when asked). */
  async list(projectId: string, query: RunsQuery = {}): Promise<RunsList> {
    const key = `${projectId}\0${query.workflow ?? ''}\0${query.branch ?? ''}`;
    const kept = this.lists.get(key);
    const ttl = kept?.list.kind === 'github' && kept.list.runs.some(isLive) ? LIVE_TTL_MS : IDLE_TTL_MS;
    if (kept && !query.force && this.now() - kept.at < ttl) return kept.list;
    if (!this.root(projectId)) return { kind: 'none' };
    const repo = await this.deps.repoOf(projectId);
    if (!repo) return { kind: 'none' };
    if (this.deps.knownHost && !this.deps.knownHost(repo.host)) return { kind: 'no_gh', repo };
    return this.once(`list\0${key}`, async () => {
      let list: RunsList;
      try {
        const { runs, more } = await this.deps.source.runs(repo, { ...(query.workflow ? { workflow: query.workflow } : {}), ...(query.branch ? { branch: query.branch } : {}) });
        list = { kind: 'github', repo, runs, more, fetchedAt: this.now() };
      } catch (err) {
        if (!(await this.deps.ghReady(repo.host).catch(() => false))) return { kind: 'no_gh', repo } as const;
        return { kind: 'error', repo, message: ghWords(err, repo) } as const;
      }
      this.lists.set(key, { at: this.now(), list });
      return list;
    });
  }

  /** One run with its jobs and steps, and the workflow file it ran. */
  async get(projectId: string, id: number, force = false): Promise<{ readonly repo: GitHubRepo; readonly run: GhRunFull }> {
    const repo = await this.repo(projectId);
    const key = `${projectId}\0${id}`;
    const kept = this.runs.get(key);
    if (kept && !force && this.now() - kept.at < (isLive(kept.run) ? LIVE_TTL_MS : DONE_TTL_MS)) return { repo, run: kept.run };
    return this.once(`run\0${key}`, async () => {
      try {
        const [run, jobs] = await Promise.all([this.deps.source.run(repo, id), this.deps.source.jobs(repo, id)]);
        const file = run.path && run.sha ? await this.fileAt(repo, run.path, run.sha) : undefined;
        const full: GhRunFull = { ...run, jobs, ...(file !== undefined ? { file } : {}) };
        this.runs.set(key, { at: this.now(), run: full });
        // What the list says about it is out of date once it's been looked at closely.
        if (!isLive(full)) for (const [k, v] of this.lists) if (v.list.kind === 'github' && v.list.runs.some((r) => r.id === id && isLive(r))) this.lists.delete(k);
        return { repo, run: full };
      } catch (err) {
        throw new Error(await this.words(err, repo));
      }
    });
  }

  private async fileAt(repo: GitHubRepo, path: string, sha: string): Promise<string | undefined> {
    const key = `${repo.host}/${repo.owner}/${repo.repo}\0${path}\0${sha}`;
    if (this.files.has(key)) return this.files.get(key);
    const text = await this.deps.source.file(repo, path, sha);
    this.files.set(key, text);
    if (this.files.size > 200) this.files.delete(this.files.keys().next().value!);
    return text;
  }

  /**
   * The project's workflows, each with its file: from the project's folder when it's there (what
   * you're working on), else as GitHub has it on the default branch. Files only in the folder
   * (not pushed yet) are there too.
   */
  async workflows(projectId: string, force = false): Promise<{ readonly repo: GitHubRepo; readonly workflows: readonly GhWorkflow[] }> {
    const repo = await this.repo(projectId);
    const kept = this.flows.get(projectId);
    let flows: readonly GhWorkflow[];
    if (kept && !force && this.now() - kept.at < WORKFLOWS_TTL_MS) flows = kept.flows;
    else {
      try {
        flows = await this.once(`flows\0${projectId}`, () => this.deps.source.workflows(repo));
      } catch (err) {
        throw new Error(await this.words(err, repo));
      }
      this.flows.set(projectId, { at: this.now(), flows });
    }
    const local = await this.localWorkflows(projectId);
    const known = new Set(flows.map((f) => f.path));
    const withFiles = await Promise.all(
      flows
        // GitHub's own (Dependabot, Pages, Copilot) have no file to draw.
        .filter((f) => f.path.startsWith('.github/'))
        .map(async (f): Promise<GhWorkflow> => {
          const file = local.get(f.path) ?? (await this.deps.source.file(repo, f.path).catch(() => undefined));
          return file !== undefined ? { ...f, file } : f;
        }),
    );
    const fresh = [...local].filter(([path]) => !known.has(path)).map(([path, file]): GhWorkflow => ({ id: 0, name: path.split('/').pop()!, path, state: 'not_pushed', url: '', file }));
    return { repo, workflows: [...withFiles, ...fresh] };
  }

  private async localWorkflows(projectId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const root = this.deps.localFiles === false ? undefined : this.root(projectId);
    if (!root) return out;
    const dir = join(root, '.github', 'workflows');
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => /\.ya?ml$/i.test(n)).sort()) {
      const text = await readFile(join(dir, name), 'utf8').catch(() => undefined);
      if (text !== undefined && text.length <= MAX_FILE) out.set(`.github/workflows/${name}`, text);
    }
    return out;
  }

  /** The end of one of a run's jobs' logs (where it failed). */
  async log(projectId: string, jobId: number): Promise<string> {
    const repo = await this.repo(projectId);
    try {
      return await this.deps.source.log(repo, jobId);
    } catch (err) {
      throw new Error(await this.words(err, repo));
    }
  }

  /** Run it again: only the jobs that failed (and what needs them), or all of it. */
  async rerun(projectId: string, id: number, failedOnly: boolean): Promise<void> {
    const repo = await this.repo(projectId);
    try {
      await this.deps.source.rerun(repo, id, failedOnly);
    } catch (err) {
      throw new Error(await this.words(err, repo));
    }
    this.forget(projectId, id);
  }

  async cancel(projectId: string, id: number): Promise<void> {
    const repo = await this.repo(projectId);
    try {
      await this.deps.source.cancel(repo, id);
    } catch (err) {
      throw new Error(await this.words(err, repo));
    }
    this.forget(projectId, id);
  }

  private forget(projectId: string, id: number): void {
    this.runs.delete(`${projectId}\0${id}`);
    for (const k of [...this.lists.keys()]) if (k.startsWith(`${projectId}\0`)) this.lists.delete(k);
  }
}
