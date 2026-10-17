import type { AgentPlace } from '../agent/types.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { Workspace } from '../workspaces/types.js';
import type { ShareService } from './shares.js';
import { type LogItem, type Store, channelOf } from './store.js';
import type { Conversation } from '../agent/transcript.js';

export interface ControllerDeps {
  readonly manager: WorkspaceManager;
  readonly store: Store;
  readonly shares: ShareService;
  readonly selfId: () => string;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** Ask your own Claude to do something in a workspace conversation. */
  readonly askClaude: (prompt: string, channel: string) => void;
  /** The latest Claude Code conversation in a folder (from other tools), to show and continue. */
  readonly findConversation?: (dir: string) => Promise<Conversation | undefined>;
}

const HISTORY_SAVE_MS = 400;

export const REVIEW_PROMPT = [
  'Review everything done in this workspace compared to its base branch. Use parallel sub-agents for:',
  '1. Correctness and bugs (logic errors, edge cases, error handling)',
  '2. Security (injection, secrets, auth, unsafe input, dependency risks)',
  '3. Tests (run them; check coverage of the new code; add missing tests if quick)',
  '4. Quality (readability, duplication, naming, dead code)',
  'Then summarize: what changed, issues found ranked by severity with file:line, and what you fixed. Say clearly whether it is ready to merge.',
].join('\n');
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
    const members = this.deps.store.getState().members;
    for (const p of projects) {
      for (const w of p.workspaces) {
        const name = shareNameOf(w.id);
        // People you invited into a workspace can browse its folder; nobody else can.
        const allowed = Object.keys(members[w.id] ?? {});
        if (w.archived) this.deps.shares.remove(name);
        else this.deps.shares.upsert({ name, root: w.path, writable: false, private: true, allowed });
      }
    }
    this.deps.store.dispatch({ type: 'projects', projects, groups: this.deps.manager.groups });
  }

  /** Show a workspace (chat, files, or review), loading its saved conversation the first time. */
  open(id: string, tab: 'chat' | 'files' | 'review' = 'chat'): void {
    const ws = this.deps.manager.find(id);
    if (!ws) return this.deps.toast('That workspace no longer exists', 'warn');
    const channel = `${WS_PREFIX}${id}`;
    if (!this.loaded.has(channel)) {
      this.loaded.add(channel);
      const saved = this.deps.manager.loadHistory<LogItem>(id);
      this.deps.store.dispatch({ type: 'history', channel, items: saved });
      if (!saved.length && !ws.sessionId) void this.importConversation(ws.id, ws.path, channel);
    }
    this.deps.store.dispatch({ type: 'view', view: { kind: 'workspace', id, tab } });
    if (tab === 'review') void this.loadReview(id);
  }

  /**
   * A workspace klaude hasn't talked in yet (a worktree from Conductor, Claude Code, or your
   * main folder) shows the latest Claude Code conversation from that folder, and Claude
   * continues it from there.
   */
  private async importConversation(id: string, dir: string, channel: string): Promise<void> {
    try {
      const found = await this.deps.findConversation?.(dir);
      if (!found?.items.length) return;
      const now = this.deps.store.getState().log.filter((l) => l.channel === channel);
      if (now.length) return; // you started talking meanwhile
      const when = new Date(found.lastModified).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const note: LogItem = { id: `import-${found.sessionId}`, type: 'system', channel, text: `Continuing "${found.title}" from Claude Code (last active ${when}). Claude remembers all of it.`, ts: Date.now(), level: 'info' };
      this.deps.store.dispatch({ type: 'history', channel, items: [...found.items, note] });
      if (!this.deps.manager.find(id)?.sessionId) this.deps.manager.rememberSession(id, found.sessionId);
    } catch {
      // No transcript to show: the conversation simply starts fresh.
    }
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

  async newChat(projectId: string, title: string, inDir?: string): Promise<Workspace | undefined> {
    const ws = await this.act("Couldn't start the chat", () => this.deps.manager.createChat(projectId, title, inDir));
    if (ws) this.open(ws.id);
    return ws;
  }

  /** Turn a draft into a real chat with your first message, then send it to Claude. */
  async startChat(projectId: string, firstMessage: string, inDir?: string): Promise<void> {
    const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 40);
    const ws = await this.newChat(projectId, title, inDir);
    if (ws) this.deps.askClaude(firstMessage, `${WS_PREFIX}${ws.id}`);
  }

  /** Turn a draft into a worktree: a small model names it after your first message, then Claude starts on it. */
  async startWorktree(projectId: string, firstMessage: string, nameTask: (prompt: string) => Promise<string>): Promise<void> {
    this.deps.toast('Naming the worktree…');
    const name = await nameTask(firstMessage);
    const ws = await this.newWorktree(projectId, name);
    if (ws) this.deps.askClaude(firstMessage, `${WS_PREFIX}${ws.id}`);
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

  /** Look for env changes before archiving/deleting, so the confirm dialog can offer to keep them. */
  prepareRemoval(id: string): void {
    let changes: ReturnType<WorkspaceManager['envChanges']> = [];
    try {
      changes = this.deps.manager.envChanges(id);
    } catch {
      changes = [];
    }
    this.deps.store.dispatch({ type: 'env_changes', id, changes });
  }

  applyEnvBack(id: string): void {
    try {
      const n = this.deps.manager.applyEnvBack(id);
      this.deps.toast(n ? `Copied env changes from ${n} file(s) into the main folder` : 'No env changes to copy', 'success');
    } catch (err) {
      this.deps.toast(`Couldn't copy env changes: ${errorText(err)}`, 'error');
    }
  }

  async restore(id: string): Promise<void> {
    if (await this.act("Couldn't restore", () => this.deps.manager.restore(id).then(() => true))) this.open(id);
  }

  async remove(id: string): Promise<void> {
    const done = await this.act("Couldn't delete", () => this.deps.manager.remove(id).then(() => true));
    if (done) {
      this.loaded.delete(`${WS_PREFIX}${id}`);
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
    this.deps.store.dispatch({ type: 'conflicts', id, files: !result.ok && result.reason === 'conflict' ? result.files : [] });
    if (result.ok) {
      this.deps.toast(`Merged ${ws.branch} into the main folder`, 'success');
      return;
    }
    if (result.reason === 'wrong_branch') {
      this.deps.toast(`The main folder is on ${result.current}, not ${result.expected}. Switch it to ${result.expected} first.`, 'warn');
      return;
    }
    if (result.reason === 'dirty') {
      this.deps.toast(`The main folder has uncommitted changes (${result.files.slice(0, 3).join(', ')}). Commit or stash them first.`, 'warn');
      return;
    }
    this.deps.toast(`Merge conflict in ${result.files.length} file(s). Click "Solve merge conflict" to let Claude handle it.`, 'warn');
  }

  /** Put a project in a group (or none). */
  async cleanAgentWorktrees(projectId: string): Promise<void> {
    const res = await this.act("Couldn't clean up", () => this.deps.manager.cleanAgentWorktrees(projectId));
    if (res) this.deps.toast(`Removed ${res.removed} finished agent worktree${res.removed === 1 ? '' : 's'}${res.kept ? ` · kept ${res.kept} with uncommitted work` : ''}`, 'success');
  }

  /** Start a fresh Claude conversation in this workspace (the old one is no longer resumed). */
  forgetConversation(id: string): void {
    this.deps.manager.forgetSession(id);
  }

  async setGroup(projectId: string, group: string | undefined): Promise<void> {
    try {
      this.deps.manager.setGroup(projectId, group);
      await this.refresh();
      this.deps.toast(group ? `Moved to group "${group}"` : 'Removed from its group', 'success');
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
    }
  }

  async hideProject(projectId: string): Promise<void> {
    this.deps.manager.hideProject(projectId);
    await this.refresh();
    this.deps.toast('Project hidden. Add it back with /project add <path>', 'success');
  }

  askClaudeToMerge(id: string, conflicts: readonly string[] = this.deps.store.getState().conflicts[id] ?? []): void {
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

  /** Shrink the conversation's context: Claude summarizes what matters and continues from there. */
  compact(id: string, instructions = ''): void {
    this.open(id);
    this.deps.askClaude(`/compact${instructions ? ` ${instructions}` : ''}`, `${WS_PREFIX}${id}`);
  }

  /** A thorough review of everything done in this workspace, posted into its chat. */
  askClaudeToReview(id: string): void {
    this.open(id);
    this.deps.askClaude(REVIEW_PROMPT, `${WS_PREFIX}${id}`);
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
