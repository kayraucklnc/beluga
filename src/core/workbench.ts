import { spawn } from 'node:child_process';
import { type PtyProcess, type TerminalManager, listShells, scriptShell } from '../terminal/index.js';
import { type ShellChoice, shellArgs } from '../shared/shells.js';
import type { EnvPlace } from './env-vars.js';
import { systemOpen } from './os-open.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { Workspace } from '../workspaces/types.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import { formatBytes, measureAll } from '../workspaces/disk.js';
import { buildPrPrompt, customPrPrompt, ensurePrPromptFile, findPr, fixChecksPrompt, hasGh, resetPrPrompt } from '../workspaces/pr.js';
import { checkSetup, scriptEnv } from '../workspaces/scripts.js';
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
const PR_EVERY_MS = 90_000;
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
  if (before.review !== pr.review && pr.review === 'CHANGES_REQUESTED') out.push({ kind: 'pr', title: `Changes requested on PR #${pr.number}`, body: name, channel });
  if (before.review !== pr.review && pr.review === 'APPROVED') out.push({ kind: 'pr', title: `PR #${pr.number} was approved`, body: name, channel });
  return out;
}


/**
 * Everything around a workspace besides talking to Claude: its terminal, setup and run
 * scripts, pull requests, models, how much space and usage it takes, search, templates.
 */
export class Workbench {
  private diskTimer?: NodeJS.Timeout;
  private prTimer?: NodeJS.Timeout;
  private readonly watchers = new Map<string, () => void>();
  private prsSeeded = false;
  /** Worktrees you asked Claude to open a PR for: their PR appearing is worth a notification. */
  private readonly prAsked = new Set<string>();

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
    this.prTimer = setInterval(() => void this.refreshPrs(), PR_EVERY_MS);
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

  fixChecks(id: string): void {
    const pr = this.deps.store.getState().prs[id];
    if (!pr) return;
    this.deps.controller.open(id);
    this.deps.askClaude(fixChecksPrompt(pr), `ws:${id}`);
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
    const find = this.deps.findPr ?? findPr;
    const state = this.deps.store.getState();
    const list = this.manager.list.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && w.branch && !w.archived && worktreeOrigin(w) === 'klaud' && (only ? w.id === only : (w.status?.ahead ?? 0) > 0 || state.prs[w.id]));
    // The first look after starting only learns what exists; news is what changes after that.
    const quiet = !this.prsSeeded && !only;
    for (const ws of list) {
      let pr: PullRequest | undefined;
      try {
        pr = await find(ws.path, ws.branch!);
      } catch {
        continue; // gh couldn't tell this time: keep what we knew
      }
      const before = this.deps.store.getState().prs[ws.id];
      this.deps.store.dispatch({ type: 'pr', id: ws.id, pr });
      if (!pr || quiet) continue;
      const asked = this.prAsked.delete(ws.id);
      for (const e of prNews(ws.name, `ws:${ws.id}`, before, pr, asked)) this.deps.notify(e);
    }
    if (!only) this.prsSeeded = true;
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
    const env = { ...this.deps.envFor?.('id' in ws ? { workspaceId: ws.id } : { dir: ws.path }), ...('projectRoot' in ws ? scriptEnv(ws) : {}) };
    const session = terminals.open(key, {
      cwd: ws.path,
      cols: size.cols,
      rows: size.rows,
      env,
      ...(shell ? { shell } : {}),
      ...(command ? { args: ['-l', '-c', command], title: command } : { args: shellArgs({ login: prefs.shellLogin, extra: prefs.shellArgs }) }),
    });
    this.deps.store.dispatch({ type: 'terminal', id: key, title: session.title });
    // Every screen sees when it ends (the tab shows its exit code; clicking starts it again).
    const report = (code: number | null): void => {
      if (this.deps.terminals?.get(key) === session) this.deps.store.dispatch({ type: 'terminal_exit', id: key, code });
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

  /** Close a terminal session (shell, setup or run). */
  closeTerminal(key: string): void {
    this.watchers.get(key)?.();
    this.watchers.delete(key);
    this.deps.terminals?.close(key);
    this.deps.store.dispatch({ type: 'terminal', id: key });
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
   * from the repository itself (klaud.json / conductor.json) asks you the first time it would
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
    const fromRepo = setup.source === 'klaud.json' || setup.source === 'conductor.json';
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
   * Set a project's setup or run command for you, or (`team`) in its klaud.json so everyone on
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
      this.deps.toast(value ? `${label}: ${value}${team ? ' (saved to klaud.json)' : ''}` : `${label} command cleared`, 'success');
    } catch (err) {
      this.deps.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  /** Put your commands in the project's klaud.json so teammates get them. */
  shareScripts(projectId: string): void {
    const p = this.manager.list.find((x) => x.id === projectId);
    if (!p?.scripts) return;
    this.manager.setScripts(projectId, { setup: p.scripts.setup?.command, run: p.scripts.run?.command }, { inRepo: true });
    void this.deps.controller.refresh();
    this.deps.toast(`Saved to ${p.name}/klaud.json. Commit it to share it`, 'success');
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
