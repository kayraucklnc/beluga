import { spawn } from 'node:child_process';
import { type PtyProcess, type TerminalManager, listShells, scriptShell } from '../terminal/index.js';
import { type ShellChoice, shellArgs } from '../shared/shells.js';
import type { EnvPlace } from './env-vars.js';
import { systemOpen } from './os-open.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { Workspace } from '../workspaces/types.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { formatBytes, measureAll } from '../workspaces/disk.js';
import { contentIn, fetchRemote, resetTo } from '../workspaces/git.js';
import { type MergeOptions, type MergeProblem, buildPrPrompt, catchUpPrompt, resolvePrConflictsPrompt, customPrPrompt, deleteRemoteBranch, ensurePrPromptFile, explainMergeError, findPr, fixChecksPrompt, hasGh, listPrs, mergePr, remoteRef, resetPrPrompt } from '../workspaces/pr.js';
import { PROJECT_FILES, checkSetup, projectFileName, scriptEnv } from '../workspaces/scripts.js';
import type { SetupFix } from '../agent/setup-fixer.js';
import type { NoticeEvent } from './notify.js';
import { type SearchSource, searchConversations } from './search.js';
import { type LogItem, type Prefs, type Store } from './store.js';
import { addTemplate, loadTemplates, removeTemplate } from './templates.js';
import type { ModelChoice, PullRequest } from './work-store.js';
import type { WorkspaceController } from './workspace-controller.js';
import type { Intent } from './intents.js';

export interface WorkbenchDeps {
  readonly store: Store;
  readonly controller: WorkspaceController;
  /** Shell sessions for the Terminal tab (omitted where there's no terminal, e.g. tests). */
  readonly terminals?: TerminalManager;
  readonly notify: (event: NoticeEvent) => void;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** Ask the screen to go somewhere, open a dialog or close a tab (see core/intents.ts). */
  readonly intend: (intent: Intent) => void;
  /** Ask your Claude in a workspace conversation. */
  readonly askClaude: (prompt: string, channel: string) => void;
  readonly setPrefs: (prefs: Partial<Prefs>) => void;
  /** Ask you before something runs by itself the first time (e.g. a repo's own setup command). */
  readonly confirm?: (title: string, detail: string) => Promise<'yes' | 'no' | 'always'>;
  /** Open a URL or a file with the system's default app. */
  readonly open?: (target: string) => void;
  /** Models your Claude Code offers (asked once). */
  readonly listModels?: () => Promise<readonly ModelChoice[] | undefined>;
  /** Look for a pull request (injected in tests). */
  readonly findPr?: (dir: string, branch: string) => Promise<PullRequest | undefined>;
  /** A repository's recent PRs by branch, in one call (injected in tests; without it, with an injected findPr, PRs are looked up one by one). */
  readonly listPrs?: (dir: string) => Promise<{ prs: ReadonlyMap<string, PullRequest>; full: boolean }>;
  /** Merge a PR on GitHub (injected in tests; throws gh's error). */
  readonly mergePr?: (dir: string, number: number, opts: MergeOptions) => Promise<void>;
  /** Delete a merged branch on GitHub (injected in tests). */
  readonly deleteRemoteBranch?: (dir: string, branch: string) => Promise<void>;
  /** Where a branch was last pushed to (its remote-tracking ref), to notice pushes. */
  readonly remoteRef?: (dir: string, branch: string) => string | undefined;
  /** The clock (injected in tests). */
  readonly now?: () => number;
  readonly hasGh?: () => Promise<boolean>;
  readonly measure?: (dir: string) => Promise<number | undefined>;
  /** Your environment variables for something starting there (see env-vars.ts). */
  readonly envFor?: (where: EnvPlace) => Record<string, string>;
  /** The shells you can pick (injected in tests). */
  readonly listShells?: () => ShellChoice[];
  /** What a project's setup should be after it failed in `dir` (a small model looks). */
  readonly fixSetup?: (dir: string, failed: string, output: string) => Promise<SetupFix | undefined>;
}

const DISK_EVERY_MS = 5 * 60_000;
/** How often to see which PRs are due a look (cheap: no gh unless one is). */
const PR_TICK_MS = 5_000;
/** PRs with checks running, or a branch just pushed. */
export const PR_FAST_MS = 15_000;
/** Other open PRs, and worktrees with commits but no PR yet. */
export const PR_SLOW_MS = 60_000;
/** A push keeps its PR on the fast cadence this long (CI starts, a PR gets opened). */
const PR_PUSHED_FOR_MS = 3 * 60_000;
/** Coming back to the window refreshes PRs not looked at in this long. */
const PR_FOCUS_FRESH_MS = 5_000;
/** gh calls at once. */
const PR_CONCURRENCY = 3;
/** Terminal size until the Terminal tab is shown (it resizes to fit). */
const START_SIZE = { cols: 120, rows: 30 };

export { shellId, setupId, runId, globalShellId, isGlobalShell, globalShellNumber, globalShellDir } from '../shared/terminal-keys.js';
import { runId, setupId, shellId, isGlobalShell, globalShellNumber, cleanTerminalName } from '../shared/terminal-keys.js';

/**
 * What changed about a pull request that's worth telling you. A PR showing up is only news
 * when you asked Claude for it (`asked`); otherwise it already existed and isn't.
 */
export function prNews(name: string, channel: string, before: PullRequest | undefined, pr: PullRequest, asked = false): NoticeEvent[] {
  if (!before) return asked && pr.state === 'OPEN' ? [{ kind: 'pr', title: `Pull request #${pr.number} is open for ${name}`, body: pr.title, channel }] : [];
  const out: NoticeEvent[] = [];
  if (before.checks !== pr.checks && (pr.checks === 'passing' || pr.checks === 'failing')) out.push({ kind: pr.checks === 'failing' ? 'problems' : 'pr', title: `Checks ${pr.checks} on PR #${pr.number}`, body: `${name} · ${pr.title}`, channel });
  if (before.state !== 'MERGED' && pr.state === 'MERGED') out.push({ kind: 'pr', title: `PR #${pr.number} was merged`, body: name, channel });
  if (before.state === 'OPEN' && pr.state === 'CLOSED') out.push({ kind: 'pr', title: `PR #${pr.number} was closed without merging`, body: name, channel });
  if (before.review !== pr.review && pr.review === 'CHANGES_REQUESTED') out.push({ kind: 'pr', title: `Changes requested on PR #${pr.number}`, body: name, channel });
  if (before.review !== pr.review && pr.review === 'APPROVED') out.push({ kind: 'pr', title: `PR #${pr.number} was approved`, body: name, channel });
  return out;
}

/**
 * How long until a worktree's PR is worth asking gh about again; undefined: not by itself
 * (merged or closed). `pushedAt`: when its branch was last pushed.
 */
export function prCadence(pr: PullRequest | undefined, pushedAt: number | undefined, now: number): number | undefined {
  if (pushedAt !== undefined && now - pushedAt < PR_PUSHED_FOR_MS) return PR_FAST_MS;
  if (!pr) return PR_SLOW_MS;
  if (pr.state !== 'OPEN') return undefined;
  return pr.checks === 'pending' ? PR_FAST_MS : PR_SLOW_MS;
}

/**
 * How a merge on GitHub went: `merged` now, or `queued` (auto-merge is on, or the repository's
 * merge queue took it); else why not, in words you can act on.
 */
export type MergeOutcome = { readonly ok: true; readonly result: 'merged' | 'queued'; readonly message: string } | { readonly ok: false; readonly reason: MergeProblem | 'no_pr' | 'busy'; readonly message: string };

/** Run `tasks`, at most `limit` at a time. */
async function inPool(tasks: ReadonlyArray<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

const samePr = (a: PullRequest | undefined, b: PullRequest | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Variables as text in one order, to tell whether they changed (kept only in memory, on this Mac). */
const envText = (vars: Readonly<Record<string, string>>): string => JSON.stringify(Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));


/**
 * Everything around a workspace besides talking to Claude: its terminal, setup and run
 * scripts, pull requests, models, how much space and usage it takes, search, templates.
 */
export class Workbench {
  private diskTimer?: NodeJS.Timeout;
  private prTimer?: NodeJS.Timeout;
  private readonly watchers = new Map<string, () => void>();
  /**
   * What each terminal started with: where (for its variables now) and the variables as text.
   * A program's variables are fixed when it starts, so after you change
   * them (Settings › Environment) the ones still running are marked for a restart.
   */
  private readonly started = new Map<string, { place: EnvPlace; env: string }>();
  private prsSeeded = false;
  /** Worktrees you asked Claude to open a PR for: their PR appearing is worth a notification. */
  private readonly prAsked = new Set<string>();
  /** When each worktree's PR was last asked about. */
  private readonly prChecked = new Map<string, number>();
  /** When each worktree's branch was last seen pushed, and the remote ref it was at. */
  private readonly pushedAt = new Map<string, number>();
  private readonly remoteSeen = new Map<string, string | undefined>();
  /** PRs already announced as merged or closed ("<ws>#<number>:<state>"), so that's said once. */
  private readonly prEnded = new Set<string>();
  private polling = false;
  /** Focus and push looks asked for while a look ran (or before the first): they run right after, never dropped. */
  private pollQueue: Array<{ reason: 'focus' | 'push'; id?: string }> = [];
  /** Worktrees whose PR is being merged right now. */
  private readonly merging = new Set<string>();

  constructor(private readonly deps: WorkbenchDeps) {}

  private get manager(): WorkspaceManager {
    return this.deps.controller.manager;
  }

  get terminals(): TerminalManager | undefined {
    return this.deps.terminals;
  }

  start(): void {
    this.deps.store.dispatch({ type: 'templates', templates: loadTemplates() });
    this.deps.store.dispatch({ type: 'pr_custom', custom: Boolean(customPrPrompt()) });
    this.deps.store.dispatch({ type: 'shell_choices', shells: (this.deps.listShells ?? listShells)() });
    void (this.deps.hasGh ?? hasGh)().then((ok) => {
      this.deps.store.dispatch({ type: 'gh', ok });
      if (ok) void this.refreshPrs();
    });
    void this.deps.listModels?.().then((models) => models && this.deps.store.dispatch({ type: 'models', models }), () => undefined);
    setTimeout(() => void this.measureDisk(), 3000).unref();
    this.diskTimer = setInterval(() => void this.measureDisk(), DISK_EVERY_MS);
    this.diskTimer.unref();
    this.prTimer = setInterval(() => void this.pollPrs(), PR_TICK_MS);
    this.prTimer.unref();
  }

  stop(): void {
    clearInterval(this.diskTimer);
    clearInterval(this.prTimer);
    for (const off of this.watchers.values()) off();
    this.deps.terminals?.closeAll();
  }

  // ------------------------------------------------------------------ models

  /** Pick the model for a conversation; `channel` undefined sets the default for new ones. */
  setModel(channel: string | undefined, value: string): void {
    const label = this.deps.store.getState().models.find((m) => m.value === value)?.label ?? (value || 'Default');
    const id = channel?.startsWith('ws:') ? channel.slice(3) : undefined;
    if (id && this.manager.find(id)) {
      this.manager.setModel(id, value || undefined);
      void this.deps.controller.refresh();
      this.deps.toast(`${label} in this conversation from the next message`, 'success');
      return;
    }
    this.deps.setPrefs({ model: value || undefined });
    this.deps.toast(`New conversations use ${label}`, 'success');
  }

  // ----------------------------------------------------------- pull requests

  private worktree(id: string): Workspace | undefined {
    const ws = this.manager.find(id);
    if (!ws || ws.kind !== 'worktree' || !ws.branch) {
      this.deps.toast('Pull requests are for worktrees (a branch of their own)', 'warn');
      return undefined;
    }
    return ws;
  }

  /** Claude commits what belongs to the work, pushes and opens a PR with a short description. */
  createPr(id: string, extra = ''): void {
    const ws = this.worktree(id);
    if (!ws?.branch) return;
    if (this.deps.store.getState().gh === false) {
      this.deps.toast('Install the GitHub CLI first: brew install gh, then gh auth login', 'warn');
      return;
    }
    const project = this.manager.list.find((p) => p.id === ws.projectId);
    const prompt = buildPrPrompt({ branch: ws.branch, base: ws.base ?? project?.base ?? 'origin/main', project: project?.name ?? '', projectPrompt: project?.scripts?.prPrompt, extra });
    if (!this.deps.store.getState().prs[ws.id]) this.prAsked.add(ws.id);
    this.deps.controller.open(ws.id);
    this.deps.askClaude(prompt, `ws:${ws.id}`);
    this.deps.toast('Claude is preparing the pull request…');
  }

  /** The branch a worktree's PRs go into ("main"). */
  private prBase(ws: Workspace): string {
    const project = this.manager.list.find((p) => p.id === ws.projectId);
    const base = (ws.base ?? project?.base ?? 'origin/main').replace(/^origin\//, '');
    return base === 'HEAD' ? (project?.sync?.branch ?? 'main') : base;
  }

  /** GitHub says the PR conflicts with its base: Claude merges the base in here, resolves it and pushes. */
  resolvePrConflicts(id: string): void {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws || !pr) return;
    this.deps.controller.open(id);
    this.deps.askClaude(resolvePrConflictsPrompt(pr, this.prBase(ws)), `ws:${id}`);
    this.deps.toast(`Claude is resolving PR #${pr.number}’s conflicts…`);
  }

  /**
   * Keep working in a worktree whose PR merged: its PR is done (the next change opens a new one),
   * and the branch starts again from the base. When everything on it is already in the base it
   * just moves there; when it has work since, Claude merges the base in so nothing is lost.
   */
  async continueAfterMerge(id: string): Promise<void> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    if (!ws?.branch) return;
    if (!pr || pr.state !== 'MERGED') return this.deps.toast('Continue After Merge is for a worktree whose pull request merged', 'info');
    if ((ws.status?.changed ?? 0) > 0) return this.deps.toast(`${ws.name} has uncommitted changes: commit them first`, 'warn');
    const base = this.prBase(ws);
    const target = `origin/${base}`;
    try {
      await fetchRemote(ws.path);
    } catch (err) {
      return this.deps.toast(`Couldn’t fetch ${target}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    const done = await contentIn(ws.path, 'HEAD', target);
    this.manager.setPrDone(id, pr.number);
    this.deps.store.dispatch({ type: 'pr', id, pr: undefined });
    if (done) {
      try {
        await resetTo(ws.path, target);
      } catch (err) {
        return this.deps.toast(`Couldn’t move ${ws.branch} to ${target}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
      await this.deps.controller.refresh();
      this.deps.toast(`PR #${pr.number} is done. ${ws.branch} now starts from the latest ${base}: the next change gets a new pull request`, 'success');
      return;
    }
    await this.deps.controller.refresh();
    this.deps.controller.open(id);
    this.deps.askClaude(catchUpPrompt(pr, base), `ws:${id}`);
    this.deps.toast(`${ws.branch} has work since PR #${pr.number}: Claude is bringing in the latest ${base}`);
  }

  fixChecks(id: string): void {
    const pr = this.deps.store.getState().prs[id];
    if (!pr) return;
    this.deps.controller.open(id);
    this.deps.askClaude(fixChecksPrompt(pr), `ws:${id}`);
  }

  /**
   * Merge a worktree's PR on GitHub (gh pr merge), or with `auto` once its checks and reviews pass;
   * then look at it again at once, so it shows Merged. GitHub's "no" comes back as a reason and a
   * sentence (a review is required, it conflicts…).
   */
  async mergePr(id: string, opts: MergeOptions): Promise<MergeOutcome> {
    const ws = this.worktree(id);
    const pr = this.deps.store.getState().prs[id];
    const fail = (reason: Extract<MergeOutcome, { ok: false }>['reason'], message: string): MergeOutcome => {
      this.deps.toast(message, reason === 'busy' ? 'info' : 'error');
      return { ok: false, reason, message };
    };
    if (!ws?.branch || !pr) return fail('no_pr', 'This worktree has no pull request to merge yet');
    if (pr.state !== 'OPEN') return fail('closed', pr.state === 'MERGED' ? `PR #${pr.number} is already merged` : `PR #${pr.number} is closed`);
    if (this.merging.has(id)) return fail('busy', `PR #${pr.number} is already being merged`);
    this.merging.add(id);
    try {
      try {
        await (this.deps.mergePr ?? mergePr)(ws.path, pr.number, opts);
      } catch (err) {
        const problem = explainMergeError(err instanceof Error ? err.message : String(err), opts.method);
        // GitHub may know more now (a conflict, a review): show it.
        await this.refreshPrs(id);
        // Skipping the checks is an admin's right: without it GitHub says forbidden or blocked.
        if (opts.admin && (problem.reason === 'permission' || problem.reason === 'blocked')) return fail(problem.reason, 'Merging past the checks needs admin rights on this repository. Wait for the checks, or use “Merge When Checks Pass”.');
        return fail(problem.reason, problem.message);
      }
      // You merged it: no "was merged" notification on top.
      this.prEnded.add(`${id}#${pr.number}:MERGED`);
      if (opts.auto) this.pushedAt.set(id, this.now());
      await this.refreshPrs(id);
      const merged = this.deps.store.getState().prs[id]?.state === 'MERGED';
      if (merged && opts.deleteBranch) {
        await (this.deps.deleteRemoteBranch ?? deleteRemoteBranch)(ws.path, ws.branch).catch((err: unknown) => this.deps.toast(`Merged, but the branch on GitHub wasn’t deleted: ${err instanceof Error ? err.message : String(err)}`, 'warn'));
      }
      const message = merged ? `Merged PR #${pr.number}` : opts.auto ? `PR #${pr.number} merges when its checks pass` : `PR #${pr.number} is queued to merge`;
      this.deps.toast(message, 'success');
      return { ok: true, result: merged ? 'merged' : 'queued', message };
    } finally {
      this.merging.delete(id);
    }
  }

  openPr(id: string): void {
    const pr = this.deps.store.getState().prs[id];
    if (pr) (this.deps.open ?? systemOpen)(pr.url);
  }

  /**
   * Look up PRs for your worktrees with commits (and notice when one you asked for opens, or
   * checks finish). Worktrees other tools made (Claude Code sub-agents, Conductor…) are theirs to watch.
   */
  async refreshPrs(only?: string, recheckGh = false): Promise<void> {
    if (this.deps.store.getState().gh === false) {
      // "Check Again" (the Mac's Connect GitHub sheet): maybe gh was installed or signed in to since.
      if (!recheckGh || !(await (this.deps.hasGh ?? hasGh)())) return;
      this.deps.store.dispatch({ type: 'gh', ok: true });
    }
    // The first look after starting only learns what exists; news is what changes after that.
    const quiet = !this.prsSeeded && !only;
    for (const ws of this.prWorktrees(only)) this.pushed(ws);
    await this.lookUpPrs(this.prWorktrees(only), quiet);
    if (!only) {
      this.prsSeeded = true;
      await this.runQueuedPolls();
    }
  }

  /**
   * Look again at the PRs that are due (see prCadence), and right away at a branch that was just
   * pushed. Runs every few seconds; `focus`: you came back to the window, so anything not looked
   * at in the last few seconds is; `push`: a branch was pushed (`id`, or any).
   */
  async pollPrs(reason: 'tick' | 'focus' | 'push' = 'tick', id?: string): Promise<void> {
    if (this.deps.store.getState().gh !== true) return;
    if (!this.prsSeeded || this.polling) {
      // Another tick comes in a few seconds; focus and push are asked once, so they wait their turn.
      if (reason !== 'tick' && !this.pollQueue.some((q) => q.reason === reason && q.id === id)) this.pollQueue.push({ reason, ...(id ? { id } : {}) });
      return;
    }
    this.polling = true;
    try {
      const now = this.now();
      const prs = this.deps.store.getState().prs;
      const due = this.prWorktrees().filter((ws) => {
        const pushed = this.pushed(ws) || (reason === 'push' && ws.id === id);
        if (pushed) this.pushedAt.set(ws.id, now);
        const every = prCadence(prs[ws.id], this.pushedAt.get(ws.id), now);
        if (every === undefined) return false;
        return pushed || now - (this.prChecked.get(ws.id) ?? 0) >= (reason === 'focus' ? PR_FOCUS_FRESH_MS : every);
      });
      if (due.length) await this.lookUpPrs(due, false);
    } finally {
      this.polling = false;
    }
    await this.runQueuedPolls();
  }

  /** Run the focus and push looks that were asked for while another look ran. */
  private async runQueuedPolls(): Promise<void> {
    for (const q of this.pollQueue.splice(0)) await this.pollPrs(q.reason, q.id);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Your worktrees whose PRs are watched: with commits, or a PR already (or just `only`). Other tools' worktrees are theirs to watch. */
  private prWorktrees(only?: string): Workspace[] {
    const prs = this.deps.store.getState().prs;
    return this.manager.list.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && w.branch && !w.archived && worktreeOrigin(w) === 'beluga' && (only ? w.id === only : (w.status?.ahead ?? 0) > 0 || prs[w.id]));
  }

  /** Whether the branch moved on origin since last time (pushed, or fetched after someone pushed). */
  private pushed(ws: Workspace): boolean {
    const ref = (this.deps.remoteRef ?? remoteRef)(ws.path, ws.branch!);
    const known = this.remoteSeen.has(ws.id);
    const before = this.remoteSeen.get(ws.id);
    this.remoteSeen.set(ws.id, ref);
    if (!known || !ref || ref === before) return false;
    this.pushedAt.set(ws.id, this.now());
    return true;
  }

  /**
   * Ask gh about these worktrees' PRs, three calls at a time: one `gh pr list` for a project
   * with several, `gh pr view` for the rest.
   */
  private async lookUpPrs(list: readonly Workspace[], quiet: boolean): Promise<void> {
    const find = this.deps.findPr ?? findPr;
    const listAll = this.deps.listPrs ?? (this.deps.findPr ? undefined : listPrs);
    const now = this.now();
    for (const ws of list) this.prChecked.set(ws.id, now);
    const one = async (ws: Workspace): Promise<void> => {
      try {
        this.gotPr(ws, await find(ws.path, ws.branch!), quiet);
      } catch {
        // gh couldn't tell this time: keep what we knew
      }
    };
    const byProject = new Map<string, Workspace[]>();
    for (const ws of list) byProject.set(ws.projectId, [...(byProject.get(ws.projectId) ?? []), ws]);
    const later: Workspace[] = [];
    const tasks: Array<() => Promise<void>> = [];
    for (const group of byProject.values()) {
      if (!listAll || group.length < 2) {
        tasks.push(...group.map((ws) => () => one(ws)));
        continue;
      }
      tasks.push(async () => {
        let found: Awaited<ReturnType<typeof listAll>>;
        try {
          found = await listAll(group[0]!.path);
        } catch {
          return; // gh couldn't tell this time
        }
        for (const ws of group) {
          const pr = found.prs.get(ws.branch!);
          // Not in a full page: maybe just older than what came back, so asked about by itself.
          if (pr || (!found.full && !this.deps.store.getState().prs[ws.id])) this.gotPr(ws, pr, quiet);
          else later.push(ws);
        }
      });
    }
    await inPool(tasks, PR_CONCURRENCY);
    await inPool(later.map((ws) => () => one(ws)), PR_CONCURRENCY);
  }

  /** gh's answer for a worktree's branch: keep it, and tell you what changed. */
  private gotPr(ws: Workspace, found: PullRequest | undefined, quiet: boolean): void {
    // A PR you carried on after (Continue After Merge) is done: the branch waits for its next one.
    const pr = found && ws.prDone !== undefined && found.number <= ws.prDone ? undefined : found;
    const before = this.deps.store.getState().prs[ws.id];
    if (!samePr(before, pr)) this.deps.store.dispatch({ type: 'pr', id: ws.id, pr });
    if (!pr || quiet) return;
    const asked = this.prAsked.delete(ws.id);
    // Merged or closed is said once, even if gh's answers flicker.
    const ended = `${ws.id}#${pr.number}:${pr.state}`;
    const told = pr.state !== 'OPEN' && this.prEnded.has(ended);
    if (pr.state !== 'OPEN') this.prEnded.add(ended);
    for (const e of prNews(ws.name, `ws:${ws.id}`, told && before ? { ...before, state: pr.state } : before, pr, asked)) this.deps.notify(e);
  }

  /** Open your PR instructions in your editor (created with the built-in text the first time). */
  editPrPrompt(): void {
    const file = ensurePrPromptFile();
    const editor = process.env.VISUAL ?? '';
    if (/\b(code|cursor|subl|zed|mate|gedit|kate)\b/.test(editor)) spawn(editor, [file], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    else if (process.platform === 'darwin') spawn('open', ['-t', file], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
    else (this.deps.open ?? systemOpen)(file);
    this.deps.store.dispatch({ type: 'pr_custom', custom: true });
    this.deps.toast(`Opened ${file.replace(process.env.HOME ?? '', '~')}. Save it; the next PR uses it`, 'success');
  }

  resetPrPrompt(): void {
    resetPrPrompt();
    this.deps.store.dispatch({ type: 'pr_custom', custom: false });
    this.deps.toast('Pull requests use the built-in instructions again', 'success');
  }

  // ------------------------------------------------------- terminal & scripts

  private openSession(key: string, ws: Workspace | { path: string }, command?: string, size = START_SIZE): PtyProcess | undefined {
    const terminals = this.deps.terminals;
    if (!terminals) return undefined;
    const prefs = this.deps.store.getState().prefs;
    // Commands are written for sh, so they run in an sh-like shell even if yours is fish or nu.
    const shell = command ? scriptShell(prefs.shell) : prefs.shell;
    const place: EnvPlace = 'id' in ws ? { workspaceId: ws.id } : { dir: ws.path };
    const vars = this.deps.envFor?.(place) ?? {};
    const env = { ...vars, ...('projectRoot' in ws ? scriptEnv(ws) : {}) };
    const session = terminals.open(key, {
      cwd: ws.path,
      cols: size.cols,
      rows: size.rows,
      env,
      ...(shell ? { shell } : {}),
      ...(command ? { args: ['-l', '-c', command], title: command } : { args: shellArgs({ login: prefs.shellLogin, extra: prefs.shellArgs }) }),
    });
    this.deps.store.dispatch({ type: 'terminal', id: key, title: session.title });
    // A setup is over in a moment: only shells and the run command are worth a restart later.
    if (!key.endsWith(':setup')) this.started.set(key, { place, env: envText(vars) });
    this.envChanged();
    // Every screen sees when it ends (the tab shows its exit code; clicking starts it again).
    const report = (code: number | null): void => {
      if (this.deps.terminals?.get(key) !== session) return;
      this.deps.store.dispatch({ type: 'terminal_exit', id: key, code });
      this.envChanged();
    };
    if (session.exited) report(session.exited.code);
    else session.onExit((exit) => report(exit.code));
    return session;
  }

  /** The workspace's shell (started on first use). */
  shell(wsId: string, size?: { cols: number; rows: number }): PtyProcess | undefined {
    const ws = this.manager.find(wsId);
    if (!ws || ws.archived) return undefined;
    const existing = this.deps.terminals?.get(shellId(wsId));
    if (existing?.running) return existing;
    if (existing) this.deps.terminals?.close(shellId(wsId));
    return this.openSession(shellId(wsId), ws, undefined, size);
  }

  /**
   * A shell of the global Terminal tab (`key` from globalShellId), started in `dir`.
   * A running one is kept; an exited one starts again.
   */
  globalShell(key: string, dir: string, size?: { cols: number; rows: number }): PtyProcess | undefined {
    const existing = this.deps.terminals?.get(key);
    if (existing?.running) return existing;
    if (existing) this.deps.terminals?.close(key);
    return this.openSession(key, { path: dir }, undefined, size);
  }

  /** The global Terminal tab's shells, in the order they were opened. */
  globalShells(): string[] {
    return (this.deps.terminals?.list() ?? []).map((s) => s.id).filter(isGlobalShell).sort((a, b) => globalShellNumber(a) - globalShellNumber(b));
  }

  /** Name a terminal for every screen (an empty name goes back to Shell N). Kept until it's closed. */
  renameTerminal(key: string, name: string): void {
    if (!(key in this.deps.store.getState().terminals)) return;
    const clean = cleanTerminalName(name);
    this.deps.store.dispatch({ type: 'terminal_name', id: key, ...(clean ? { name: clean } : {}) });
  }

  /**
   * Your variables changed (Settings › Environment, /env): mark the terminals still running with
   * the ones they started with. Claude and new terminals already get the new ones.
   */
  envChanged(): void {
    const stale = [...this.started]
      .filter(([key, s]) => this.deps.terminals?.get(key)?.running && envText(this.deps.envFor?.(s.place) ?? {}) !== s.env)
      .map(([key]) => key)
      .sort();
    this.deps.store.dispatch({ type: 'terminal_env_stale', ids: stale });
  }

  /** Start a shell or the run command again, so it has your variables as they are now (its name stays). */
  restartTerminal(key: string): PtyProcess | undefined {
    const was = this.started.get(key);
    const name = this.deps.store.getState().termNames[key];
    const keepName = (session: PtyProcess | undefined): PtyProcess | undefined => {
      if (session && name) this.deps.store.dispatch({ type: 'terminal_name', id: key, name });
      return session;
    };
    if (isGlobalShell(key)) {
      if (!was?.place.dir) return undefined;
      this.closeTerminal(key);
      return keepName(this.globalShell(key, was.place.dir));
    }
    if (key.endsWith(':setup')) return undefined;
    if (key.endsWith(':run')) {
      const wsId = key.slice(0, -':run'.length);
      this.closeTerminal(key);
      return this.run(wsId);
    }
    this.closeTerminal(key);
    return keepName(this.shell(key));
  }

  /** Close a terminal session (shell, setup or run). */
  closeTerminal(key: string): void {
    this.watchers.get(key)?.();
    this.watchers.delete(key);
    this.deps.terminals?.close(key);
    this.deps.store.dispatch({ type: 'terminal', id: key });
    if (this.started.delete(key)) this.envChanged();
    // A setup that was closed before it finished isn't "setting up" anymore.
    const wsId = key.endsWith(':setup') ? key.slice(0, -':setup'.length) : undefined;
    if (wsId && this.deps.store.getState().setup[wsId]?.status === 'running') this.deps.store.dispatch({ type: 'setup', id: wsId });
  }

  /** Stop a workspace's shell, setup and run terminals (it's being archived or deleted). */
  closeTerminals(wsId: string): void {
    for (const key of [shellId(wsId), setupId(wsId), runId(wsId)]) if (this.deps.terminals?.get(key)) this.closeTerminal(key);
  }

  private watchExit(key: string, session: PtyProcess, onExit: (code: number | null) => void): void {
    this.watchers.get(key)?.();
    if (session.exited) return onExit(session.exited.code);
    const off = session.onExit((exited) => {
      off();
      this.watchers.delete(key);
      onExit(exited.code);
    });
    this.watchers.set(key, off);
  }

  /**
   * Run the project's setup in a new worktree (visible in its Terminal tab). A command that comes
   * from the repository itself (beluga.json / conductor.json) asks you the first time it would
   * run by itself, and again whenever it changes. A command that doesn't fit the project (an
   * install with no package.json, the wrong package manager) is skipped or corrected, and remembered.
   */
  runSetup(wsId: string, auto = false): void {
    const ws = this.manager.find(wsId);
    const project = ws ? this.manager.list.find((p) => p.id === ws.projectId) : undefined;
    const setup = project?.scripts?.setup;
    const command = setup?.command;
    if (!ws || !project || !command) {
      if (!auto) this.deps.toast('This project has no setup command. Set one in its ⋯ menu', 'warn');
      return;
    }
    if (!this.deps.terminals) return;
    const fit = checkSetup(ws.path, command);
    if (fit.kind === 'skip') {
      this.learnSetup(project.id, { none: true }, `No setup for ${project.name}: ${fit.reason}. New worktrees skip it from now on`);
      return;
    }
    if (fit.kind === 'swap') {
      this.learnSetup(project.id, { command: fit.command }, `Setup for ${project.name} is now \`${fit.command}\`: ${fit.reason}`);
      return this.startSetup(ws, fit.command);
    }
    const fromRepo = setup.source === 'beluga.json' || setup.source === 'klaud.json' || setup.source === 'conductor.json';
    if (auto && fromRepo && !this.manager.isScriptApproved(project.id, command)) {
      if (!this.deps.confirm) return;
      void this.deps.confirm(`${project.name}'s ${setup.source} wants to run its setup in new worktrees`, `${command}\n\nThis comes from the repository. Allow it if you trust what's in it. "Always" remembers this exact command.`).then((answer) => {
        if (answer === 'no') return void this.deps.toast('Setup skipped. Run it any time from the Terminal tab');
        if (answer === 'always') this.manager.approveScript(project.id, command);
        this.startSetup(ws, command);
      });
      return;
    }
    this.startSetup(ws, command);
  }

  /** Remember a project's setup for you (a command, or none), so the next worktree gets it right. */
  private learnSetup(projectId: string, fix: SetupFix, note: string): void {
    try {
      this.manager.setScripts(projectId, 'none' in fix ? { setup: undefined, skipSetup: true } : { setup: fix.command, skipSetup: undefined });
      void this.deps.controller.refresh();
      this.deps.toast(note, 'success');
    } catch (err) {
      this.deps.toast(`Couldn't remember the setup: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** `learn`: if it fails, a small model works out the right setup once, and that runs instead. */
  private startSetup(ws: Workspace, command: string, learn = true): void {
    const wsId = ws.id;
    this.closeTerminal(setupId(wsId));
    const session = this.openSession(setupId(wsId), ws, command);
    if (!session) return;
    this.deps.store.dispatch({ type: 'setup', id: wsId, run: { status: 'running', command } });
    this.deps.toast(`Setting up ${ws.name}: ${command}`);
    this.watchExit(setupId(wsId), session, (code) => {
      if (code === 0) {
        this.deps.store.dispatch({ type: 'setup', id: wsId, run: { status: 'done', command } });
        this.deps.toast(`${ws.name} is set up`, 'success');
        return;
      }
      if (learn && this.deps.fixSetup) return void this.retrySetup(ws, command, code, session.backlog());
      this.setupFailed(ws, command, code);
    });
  }

  private setupFailed(ws: Workspace, command: string, code: number | null): void {
    this.deps.store.dispatch({ type: 'setup', id: ws.id, run: { status: 'failed', command, detail: `exit code ${code ?? '?'}` } });
    this.deps.notify({ kind: 'problems', title: `Setup failed in ${ws.name}`, body: `${command} (exit code ${code ?? '?'}). See its Terminal tab`, channel: `ws:${ws.id}` });
  }

  /** Setup failed: ask what it should be, remember the answer, and run that (once). */
  private async retrySetup(ws: Workspace, command: string, code: number | null, output: string): Promise<void> {
    this.deps.toast(`Setup failed in ${ws.name}. Looking for the right one…`);
    const fix = await this.deps.fixSetup!(ws.path, command, output);
    const project = this.manager.find(ws.id) && this.manager.list.find((p) => p.id === ws.projectId);
    if (!project || !fix || ('command' in fix && fix.command === command)) return this.setupFailed(ws, command, code);
    if ('none' in fix) {
      this.deps.store.dispatch({ type: 'setup', id: ws.id });
      return this.learnSetup(project.id, fix, `${project.name} needs no setup. New worktrees skip it from now on`);
    }
    this.learnSetup(project.id, fix, `Setup for ${project.name} is now \`${fix.command}\` (\`${command}\` failed)`);
    this.startSetup(ws, fix.command, false);
  }

  /** New worktrees (and forks, handoffs) get the project's setup when that's switched on. */
  onWorktreeCreated(ws: Workspace): void {
    if (this.deps.store.getState().prefs.autoSetup) this.runSetup(ws.id, true);
  }

  /**
   * An archived worktree is back: its dependencies and builds were thrown away, so the project's
   * setup makes them again; without one, say what to run.
   */
  onWorktreeRestored(ws: Workspace, remake: readonly string[]): void {
    const project = this.manager.list.find((p) => p.id === ws.projectId);
    if (project?.scripts?.setup?.command) return this.runSetup(ws.id, true);
    if (remake.length) this.deps.toast(`Restored. Its dependencies and builds were cleared when it was archived: run ${remake.map((r) => `\`${r}\``).join(', then ')} to make them again`, 'info');
  }

  /** Start (or restart) the project's run command, e.g. its dev server. */
  run(wsId: string): PtyProcess | undefined {
    const ws = this.manager.find(wsId);
    const project = ws ? this.manager.list.find((p) => p.id === ws.projectId) : undefined;
    const command = project?.scripts?.run?.command;
    if (!ws || !command) {
      this.deps.toast("This project has no run command. Set one in its ⋯ menu (Setup and run commands)", 'warn');
      return undefined;
    }
    const current = this.deps.terminals?.get(runId(wsId));
    if (current?.running) return current;
    this.closeTerminal(runId(wsId));
    return this.openSession(runId(wsId), ws, command);
  }

  stopRun(wsId: string): void {
    this.deps.terminals?.get(runId(wsId))?.kill();
  }

  /**
   * Set a project's setup or run command for you, or (`team`) in its beluga.json so everyone on
   * the project gets it; then your own one for it is dropped, so the shared one applies.
   */
  setScript(projectId: string, kind: 'setup' | 'run', command: string, team = false): void {
    try {
      const value = command.trim() || undefined;
      // Choosing a setup yourself overrides one learned as unneeded.
      const learned = kind === 'setup' ? { skipSetup: undefined } : {};
      if (team) {
        this.manager.setScripts(projectId, { [kind]: value }, { inRepo: true });
        this.manager.setScripts(projectId, { [kind]: undefined, ...learned });
      } else this.manager.setScripts(projectId, { [kind]: value, ...learned });
      void this.deps.controller.refresh();
      const label = kind === 'setup' ? 'Setup' : 'Run';
      const root = this.manager.list.find((x) => x.id === projectId)?.root;
      this.deps.toast(value ? `${label}: ${value}${team ? ` (saved to ${root ? projectFileName(root) : PROJECT_FILES[0]})` : ''}` : `${label} command cleared`, 'success');
    } catch (err) {
      this.deps.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  /** Put your commands in the project's beluga.json (or its older klaud.json) so teammates get them. */
  shareScripts(projectId: string): void {
    const p = this.manager.list.find((x) => x.id === projectId);
    if (!p?.scripts) return;
    this.manager.setScripts(projectId, { setup: p.scripts.setup?.command, run: p.scripts.run?.command }, { inRepo: true });
    void this.deps.controller.refresh();
    this.deps.toast(`Saved to ${p.name}/${projectFileName(p.root)}. Commit it to share it`, 'success');
  }

  // ------------------------------------------------------- usage & space

  /** Claude reported tokens and cost for a run in a workspace. */
  onUsage(channel: string, json: string): void {
    const id = channel.startsWith('ws:') ? channel.slice(3) : undefined;
    if (!id) return;
    try {
      const u = JSON.parse(json) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; session?: string };
      const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);
      this.manager.addUsage(id, { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite), cost: num(u.cost), session: typeof u.session === 'string' ? u.session : undefined });
      void this.deps.controller.refresh();
    } catch {
      // Not usage we understand.
    }
  }

  /** How much disk each worktree and chat folder takes. */
  async measureDisk(): Promise<void> {
    const dirs = this.manager.list
      .flatMap((p) => p.workspaces)
      .filter((w) => !w.archived && (w.kind === 'worktree' || w.kind === 'main' || (w.kind === 'chat' && !w.projectRoot)))
      .map((w) => ({ id: w.id, path: w.path }));
    const sizes = await measureAll(dirs, this.deps.measure);
    this.deps.store.dispatch({ type: 'disk', sizes });
  }

  /** "1.2 GB · 340k tokens" for a workspace. */
  describe(wsId: string): string {
    const state = this.deps.store.getState();
    const ws = this.manager.find(wsId);
    const disk = state.disk[wsId];
    const tokens = ws?.usage ? ws.usage.input + ws.usage.output + ws.usage.cacheWrite : 0;
    return [disk !== undefined ? formatBytes(disk) : '', tokens ? `${Math.round(tokens / 1000)}k tokens` : ''].filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------------ search

  /** Search every conversation: open ones, saved ones and archived ones. */
  search(query: string): void {
    const state = this.deps.store.getState();
    const loaded = new Set(state.log.map((l) => l.channel));
    const sources: SearchSource[] = [];
    const placeOf = (w: Workspace): string => {
      const p = this.manager.list.find((x) => x.id === w.projectId);
      return p?.root ? `${p.name} › ${w.name}` : w.name;
    };
    for (const channel of loaded) {
      if (channel === 'draft') continue;
      const ws = channel.startsWith('ws:') ? this.manager.find(channel.slice(3)) : undefined;
      const shared = channel.startsWith('ws:') ? state.shared.find((w) => w.id === channel.slice(3)) : undefined;
      sources.push({ channel, place: ws ? placeOf(ws) : shared ? shared.name : channel === 'room' ? (state.peers.length > 1 ? 'Group chat' : 'Chat') : channel, items: state.log.filter((l) => l.channel === channel), archived: ws?.archived });
    }
    for (const ws of this.manager.list.flatMap((p) => p.workspaces)) {
      const channel = `ws:${ws.id}`;
      if (loaded.has(channel)) continue;
      const items = this.manager.loadHistory<LogItem>(ws.id);
      if (items.length) sources.push({ channel, place: placeOf(ws), items, archived: ws.archived });
    }
    const hits = searchConversations(query, sources);
    this.deps.store.dispatch({ type: 'search', search: { query, hits, searched: sources.length } });
  }

  /** Open a search hit's conversation. */
  openHit(index: number): void {
    const state = this.deps.store.getState();
    const hit = state.search.hits[index];
    if (!hit) return;
    if (hit.channel === 'room') {
      this.deps.intend({ type: 'navigate', view: { kind: 'room' } });
      return;
    }
    const id = hit.channel.slice(3);
    const shared = state.shared.find((w) => w.id === id);
    if (shared) this.deps.intend({ type: 'navigate', view: { kind: 'shared', owner: shared.owner, id, tab: 'chat' } });
    else this.deps.controller.open(id);
  }

  // --------------------------------------------------------------- templates

  /** "/template save Fix CI: find out why CI fails…" */
  saveTemplate(text: string, plan = false): void {
    const at = text.indexOf(':');
    const name = at > 0 ? text.slice(0, at).trim() : text.trim().split(/\s+/).slice(0, 4).join(' ');
    const prompt = at > 0 ? text.slice(at + 1).trim() : text.trim();
    if (!name || !prompt) {
      this.deps.toast('Usage: /template save <name>: <what Claude should do>', 'warn');
      return;
    }
    this.deps.store.dispatch({ type: 'templates', templates: addTemplate(name, prompt, plan) });
    this.deps.toast(`Template "${name}" saved. It shows up when you start a worktree or chat`, 'success');
  }

  removeTemplate(id: string): void {
    this.deps.store.dispatch({ type: 'templates', templates: removeTemplate(id) });
    this.deps.toast('Template removed', 'success');
  }

}
