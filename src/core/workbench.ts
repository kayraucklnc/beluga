import { spawn } from 'node:child_process';
import type { TerminalManager, TerminalSession } from '../terminal/index.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { Workspace } from '../workspaces/types.js';
import { formatBytes, measureAll } from '../workspaces/disk.js';
import { buildPrPrompt, customPrPrompt, ensurePrPromptFile, findPr, fixChecksPrompt, hasGh, resetPrPrompt } from '../workspaces/pr.js';
import { scriptEnv } from '../workspaces/scripts.js';
import type { NoticeEvent } from './notify.js';
import { type SearchSource, searchConversations } from './search.js';
import { type LogItem, type Prefs, type Store, channelOf } from './store.js';
import { addTemplate, loadTemplates, removeTemplate } from './templates.js';
import type { ModelChoice, PullRequest } from './work-store.js';
import type { WorkspaceController } from './workspace-controller.js';

export interface WorkbenchDeps {
  readonly store: Store;
  readonly controller: WorkspaceController;
  /** Shell sessions for the Terminal tab (omitted where there's no terminal, e.g. tests). */
  readonly terminals?: TerminalManager;
  readonly notify: (event: NoticeEvent) => void;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
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
}

const DISK_EVERY_MS = 5 * 60_000;
const PR_EVERY_MS = 90_000;
/** Terminal size until the Terminal tab is shown (it resizes to fit). */
const START_SIZE = { cols: 120, rows: 30 };

export const shellId = (wsId: string): string => wsId;
export const setupId = (wsId: string): string => `${wsId}:setup`;
export const runId = (wsId: string): string => `${wsId}:run`;

/** What changed about a pull request that's worth telling you. */
export function prNews(name: string, channel: string, before: PullRequest | undefined, pr: PullRequest): NoticeEvent[] {
  if (!before) return [{ kind: 'pr', title: `Pull request #${pr.number} is open for ${name}`, body: pr.title, channel }];
  const out: NoticeEvent[] = [];
  if (before.checks !== pr.checks && (pr.checks === 'passing' || pr.checks === 'failing')) out.push({ kind: pr.checks === 'failing' ? 'problems' : 'pr', title: `Checks ${pr.checks} on PR #${pr.number}`, body: `${name} · ${pr.title}`, channel });
  if (before.state !== 'MERGED' && pr.state === 'MERGED') out.push({ kind: 'pr', title: `PR #${pr.number} was merged`, body: name, channel });
  if (before.review !== pr.review && pr.review === 'CHANGES_REQUESTED') out.push({ kind: 'pr', title: `Changes requested on PR #${pr.number}`, body: name, channel });
  if (before.review !== pr.review && pr.review === 'APPROVED') out.push({ kind: 'pr', title: `PR #${pr.number} was approved`, body: name, channel });
  return out;
}

const systemOpen = (target: string): void => {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [target], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
};

/**
 * Everything around a workspace besides talking to Claude: its terminal, setup and run
 * scripts, pull requests, models, how much space and usage it takes, search, templates.
 */
export class Workbench {
  private diskTimer?: NodeJS.Timeout;
  private prTimer?: NodeJS.Timeout;
  private readonly watchers = new Map<string, () => void>();
  private prsSeeded = false;

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

  /** Look up PRs for every worktree with commits (and notice when one opens or its checks finish). */
  async refreshPrs(only?: string): Promise<void> {
    if (this.deps.store.getState().gh === false) return;
    const find = this.deps.findPr ?? findPr;
    const state = this.deps.store.getState();
    const list = this.manager.list.flatMap((p) => p.workspaces).filter((w) => w.kind === 'worktree' && w.branch && !w.archived && (only ? w.id === only : (w.status?.ahead ?? 0) > 0 || state.prs[w.id]));
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
      if (pr && !quiet) for (const e of prNews(ws.name, `ws:${ws.id}`, before, pr)) this.deps.notify(e);
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

  private openSession(key: string, ws: Workspace, command?: string, size = START_SIZE): TerminalSession | undefined {
    const terminals = this.deps.terminals;
    if (!terminals) return undefined;
    const shell = this.deps.store.getState().prefs.shell;
    const session = terminals.open(key, {
      cwd: ws.path,
      cols: size.cols,
      rows: size.rows,
      env: scriptEnv(ws),
      ...(shell ? { shell } : {}),
      ...(command ? { args: ['-lc', command], title: command } : {}),
    });
    this.deps.store.dispatch({ type: 'terminal', id: key, title: session.title });
    return session;
  }

  /** The workspace's shell (started on first use). */
  shell(wsId: string, size?: { cols: number; rows: number }): TerminalSession | undefined {
    const ws = this.manager.find(wsId);
    if (!ws || ws.archived) return undefined;
    const existing = this.deps.terminals?.get(shellId(wsId));
    if (existing?.running) return existing;
    if (existing) this.deps.terminals?.close(shellId(wsId));
    return this.openSession(shellId(wsId), ws, undefined, size);
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

  private watchExit(key: string, session: TerminalSession, onExit: (code: number | null) => void): void {
    this.watchers.get(key)?.();
    const off = session.onChange(() => {
      const exited = session.snapshot().exited;
      if (!exited) return;
      off();
      this.watchers.delete(key);
      onExit(exited.code);
    });
    this.watchers.set(key, off);
  }

  /**
   * Run the project's setup in a new worktree (visible in its Terminal tab). A command that comes
   * from the repository itself (klaud.json / conductor.json) asks you the first time it would
   * run by itself, and again whenever it changes.
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

  private startSetup(ws: Workspace, command: string): void {
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
      this.deps.store.dispatch({ type: 'setup', id: wsId, run: { status: 'failed', command, detail: `exit code ${code ?? '?'}` } });
      this.deps.notify({ kind: 'problems', title: `Setup failed in ${ws.name}`, body: `${command} (exit code ${code ?? '?'}). See its Terminal tab`, channel: `ws:${wsId}` });
    });
  }

  /** New worktrees (and forks, handoffs) get the project's setup when that's switched on. */
  onWorktreeCreated(ws: Workspace): void {
    if (this.deps.store.getState().prefs.autoSetup) this.runSetup(ws.id, true);
  }

  /** Start (or restart) the project's run command, e.g. its dev server. */
  run(wsId: string): TerminalSession | undefined {
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

  setScript(projectId: string, kind: 'setup' | 'run', command: string): void {
    try {
      this.manager.setScripts(projectId, { [kind]: command.trim() || undefined });
      void this.deps.controller.refresh();
      this.deps.toast(command.trim() ? `${kind === 'setup' ? 'Setup' : 'Run'}: ${command.trim()}` : `${kind === 'setup' ? 'Setup' : 'Run'} command cleared`, 'success');
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
    this.deps.store.dispatch({ type: 'search', search: { query, hits, searched: sources.length, cursor: 0 } });
  }

  /** Open a search hit's conversation. */
  openHit(index: number): void {
    const state = this.deps.store.getState();
    const hit = state.search.hits[index];
    if (!hit) return;
    if (hit.channel === 'room') {
      this.deps.store.dispatch({ type: 'view', view: { kind: 'room' } });
      return;
    }
    const id = hit.channel.slice(3);
    const shared = state.shared.find((w) => w.id === id);
    if (shared) this.deps.store.dispatch({ type: 'view', view: { kind: 'shared', owner: shared.owner, id, tab: 'chat' } });
    else this.deps.controller.open(id);
  }

  // --------------------------------------------------------------- templates

  /** "/template save Fix CI: find out why CI fails…" */
  saveTemplate(text: string): void {
    const at = text.indexOf(':');
    const name = at > 0 ? text.slice(0, at).trim() : text.trim().split(/\s+/).slice(0, 4).join(' ');
    const prompt = at > 0 ? text.slice(at + 1).trim() : text.trim();
    if (!name || !prompt) {
      this.deps.toast('Usage: /template save <name>: <what Claude should do>', 'warn');
      return;
    }
    this.deps.store.dispatch({ type: 'templates', templates: addTemplate(name, prompt) });
    this.deps.toast(`Template "${name}" saved. It shows up when you start a worktree or chat`, 'success');
  }

  removeTemplate(id: string): void {
    this.deps.store.dispatch({ type: 'templates', templates: removeTemplate(id) });
    this.deps.toast('Template removed', 'success');
  }

  /** The conversation a view belongs to, for the model picker. */
  channelFor(): string {
    return channelOf(this.deps.store.getState().view);
  }
}
