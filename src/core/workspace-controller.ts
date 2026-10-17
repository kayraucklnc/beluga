import type { AgentPlace } from '../agent/types.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { Workspace } from '../workspaces/types.js';
import type { ShareService } from './shares.js';
import { type LogItem, type Store, channelOf } from './store.js';

export interface ControllerDeps {
  readonly manager: WorkspaceManager;
  readonly store: Store;
  readonly shares: ShareService;
  readonly selfId: () => string;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** Ask your own Claude to do something in a workspace conversation. */
  readonly askClaude: (prompt: string, channel: string) => void;
}

const HISTORY_SAVE_MS = 400;
const WS_PREFIX = 'ws:';

export const workspaceIdOf = (channel: string): string | undefined => (channel.startsWith(WS_PREFIX) ? channel.slice(WS_PREFIX.length) : undefined);
export const shareNameOf = (id: string): string => `ws-${id.replace(/[^\w.-]/g, '_')}`;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Connects projects and workspaces to the room: views, conversations (one Claude
 * session per workspace, history saved to disk), and every workspace action.
 */
export class WorkspaceController {
  private readonly loaded = new Set<string>();
  private saveTimer?: NodeJS.Timeout;
  private lastLog: readonly LogItem[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: ControllerDeps) {
    this.unsubscribe = deps.store.subscribe(() => this.scheduleSave());
  }

  get manager(): WorkspaceManager {
    return this.deps.manager;
  }

  stop(): void {
    this.unsubscribe();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveNow();
    }
  }

  /** Re-scan projects and publish them; every workspace's folder becomes a private share. */
  async refresh(): Promise<void> {
    const projects = await this.deps.manager.refresh();
    for (const p of projects) {
      for (const w of p.workspaces) {
        const name = shareNameOf(w.id);
        if (w.archived) this.deps.shares.remove(name);
        else this.deps.shares.upsert({ name, root: w.path, writable: false, private: true });
      }
    }
    this.deps.store.dispatch({ type: 'projects', projects });
  }

  /** Show a workspace (chat, files, or review), loading its saved conversation the first time. */
  open(id: string, tab: 'chat' | 'files' | 'review' = 'chat'): void {
    const ws = this.deps.manager.find(id);
    if (!ws) return this.deps.toast('That workspace no longer exists', 'warn');
    const channel = `${WS_PREFIX}${id}`;
    if (!this.loaded.has(channel)) {
      this.loaded.add(channel);
      this.deps.store.dispatch({ type: 'history', channel, items: this.deps.manager.loadHistory<LogItem>(id) });
    }
    this.deps.store.dispatch({ type: 'view', view: { kind: 'workspace', id, tab } });
    if (tab === 'review') void this.loadReview(id);
  }

  /** Where Claude runs for a workspace conversation: its folder, its own resumable session. */
  place(channel: string): AgentPlace | undefined {
    const id = workspaceIdOf(channel);
    const ws = id ? this.deps.manager.find(id) : undefined;
    if (!ws || ws.archived) return undefined;
    return {
      cwd: ws.path,
      additionalDirectories: [],
      // Worktrees are disposable sandboxes, so edits there don't need approval.
      autoEdit: ws.kind === 'worktree',
      resume: ws.forkFromSession ?? ws.sessionId,
      forkSession: Boolean(ws.forkFromSession),
      onSession: (sessionId) => this.deps.manager.rememberSession(ws.id, sessionId),
    };
  }

  // ------------------------------------------------------------- actions

  private async act<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await fn();
      await this.refresh();
      return result;
    } catch (err) {
      this.deps.toast(`${label}: ${errorText(err)}`, 'error');
      return undefined;
    }
  }

  async newWorktree(projectId: string, name: string): Promise<Workspace | undefined> {
    this.deps.toast(`Creating worktree "${name}" from the latest origin…`);
    const ws = await this.act("Couldn't create the worktree", () => this.deps.manager.createWorktree(projectId, name));
    if (ws) {
      this.deps.toast(`Worktree ${ws.name} is ready on ${ws.branch}`, 'success');
      this.open(ws.id);
    }
    return ws;
  }

  async newChat(projectId: string, title: string): Promise<Workspace | undefined> {
    const ws = await this.act("Couldn't start the chat", () => this.deps.manager.createChat(projectId, title));
    if (ws) this.open(ws.id);
    return ws;
  }

  async fork(id: string, name: string): Promise<Workspace | undefined> {
    const ws = await this.act("Couldn't fork", () => this.deps.manager.fork(id, name));
    if (ws) {
      this.deps.toast(`Forked into ${ws.name}, with the conversation so far`, 'success');
      this.loaded.delete(`${WS_PREFIX}${ws.id}`);
      this.open(ws.id);
    }
    return ws;
  }

  async archive(id: string, force = false): Promise<boolean> {
    const done = await this.act("Couldn't archive", async () => {
      await this.deps.manager.archive(id, force);
      return true;
    });
    if (done) {
      this.deps.store.dispatch({ type: 'close_tab', id });
      this.deps.toast('Archived. The branch and conversation are kept; restore it any time.', 'success');
    }
    return Boolean(done);
  }

  async restore(id: string): Promise<void> {
    if (await this.act("Couldn't restore", () => this.deps.manager.restore(id).then(() => true))) this.open(id);
  }

  async remove(id: string): Promise<void> {
    const done = await this.act("Couldn't delete", () => this.deps.manager.remove(id).then(() => true));
    if (done) {
      this.deps.store.dispatch({ type: 'close_tab', id });
      this.deps.toast('Deleted', 'success');
    }
  }

  async commit(id: string, message = 'Work from klaude'): Promise<void> {
    const committed = await this.act("Couldn't commit", () => this.deps.manager.commitAll(id, message));
    if (committed !== undefined) this.deps.toast(committed ? 'Committed all changes' : 'Nothing to commit', committed ? 'success' : 'info');
  }

  /** Merge into the main folder; on conflicts, hand the job to Claude. */
  async merge(id: string): Promise<void> {
    const ws = this.deps.manager.find(id);
    if (!ws) return;
    const result = await this.act("Couldn't merge", () => this.deps.manager.merge(id));
    if (!result) return;
    if (result.ok) {
      this.deps.toast(`Merged ${ws.branch} into the main folder`, 'success');
      return;
    }
    if (result.reason === 'dirty') {
      this.deps.toast(`The main folder has uncommitted changes (${result.files.slice(0, 3).join(', ')}). Commit or stash them first.`, 'warn');
      return;
    }
    this.deps.toast(`Merge conflicts in ${result.files.length} file(s). Asking Claude to resolve them…`, 'warn');
    this.askClaudeToMerge(id, result.files);
  }

  askClaudeToMerge(id: string, conflicts: readonly string[] = []): void {
    const ws = this.deps.manager.find(id);
    if (!ws?.branch) return;
    const project = this.deps.manager.list.find((p) => p.id === ws.projectId);
    const list = conflicts.length ? ` Conflicting files: ${conflicts.join(', ')}.` : '';
    this.open(id);
    this.deps.askClaude(
      `Merge branch ${ws.branch} into the main checkout at ${project?.root ?? ws.projectRoot}. ` +
        `Resolve any conflicts carefully, keeping both sides' intent, then run the tests and commit the merge.${list}`,
      `${WS_PREFIX}${id}`,
    );
  }

  askClaudeToReview(id: string): void {
    this.open(id);
    this.deps.askClaude(
      'Review all changes in this workspace compared to its base branch. Summarize what changed, point out bugs or risks, and suggest fixes. Use sub-agents for independent parts if helpful.',
      `${WS_PREFIX}${id}`,
    );
  }

  openInFinder(id: string): void {
    try {
      this.deps.manager.openInFinder(id);
      this.deps.toast('Opened in Finder');
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
    }
  }

  async addProject(dir: string): Promise<void> {
    try {
      this.deps.manager.addProject(dir);
      await this.refresh();
      this.deps.toast('Project added', 'success');
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
    }
  }

  async addFolder(dir: string): Promise<void> {
    try {
      const found = this.deps.manager.addFolder(dir);
      await this.refresh();
      this.deps.toast(`Watching ${dir}: ${found} project(s) found`, 'success');
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
    }
  }

  // -------------------------------------------------------------- review

  async loadReview(id: string): Promise<void> {
    this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, selected: 0, diffScroll: 0, loading: true } });
    try {
      const data = await this.deps.manager.review(id);
      this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, data, selected: 0, diffScroll: 0, loading: false } });
      if (data.files.length) await this.selectFile(0);
    } catch (err) {
      this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, selected: 0, diffScroll: 0, loading: false, error: errorText(err) } });
    }
  }

  async selectFile(index: number): Promise<void> {
    const review = this.deps.store.getState().review;
    const file = review?.data?.files[index];
    if (!review || !file) return;
    this.deps.store.dispatch({ type: 'review', review: { ...review, selected: index, diffScroll: 0, diff: undefined } });
    const diff = await this.deps.manager.fileDiff(review.workspaceId, file.path).catch((err: unknown) => `Couldn't load diff: ${errorText(err)}`);
    const latest = this.deps.store.getState().review;
    if (latest?.workspaceId === review.workspaceId && latest.selected === index) {
      this.deps.store.dispatch({ type: 'review', review: { ...latest, diff } });
    }
  }

  // ------------------------------------------------------------- history

  private scheduleSave(): void {
    const log = this.deps.store.getState().log;
    if (log === this.lastLog) return;
    this.lastLog = log;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), HISTORY_SAVE_MS);
    this.saveTimer.unref();
  }

  private saveNow(): void {
    this.saveTimer = undefined;
    const log = this.deps.store.getState().log;
    for (const channel of this.loaded) {
      const id = workspaceIdOf(channel);
      if (!id) continue;
      this.deps.manager.saveHistory(id, log.filter((l) => l.channel === channel).slice(-500));
    }
  }

  /** The workspace for the current view, if any. */
  current(): Workspace | undefined {
    const view = this.deps.store.getState().view;
    return view.kind === 'workspace' ? this.deps.manager.find(view.id) : undefined;
  }

  isCurrentChannel(channel: string): boolean {
    return channelOf(this.deps.store.getState().view) === channel;
  }
}
