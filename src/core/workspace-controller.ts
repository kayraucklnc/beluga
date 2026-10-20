import { existsSync } from 'node:fs';
import { worktreeOrigin } from '../workspaces/origin.js';
import path from 'node:path';
import { slugify } from '../agent/namer.js';
import { carrySession } from '../agent/session-carry.js';
import type { AgentPlace } from '../agent/types.js';
import { type ArrangeTarget, type WorkspaceManager, real } from '../workspaces/manager.js';
import type { Workspace } from '../workspaces/types.js';
import type { ShareService } from './shares.js';
import { type LogItem, type Store, type WorkspaceTab } from './store.js';
import { type Conversation, isImportedItem } from '../agent/transcript.js';
import type { Intent } from './intents.js';
import { type OtherTools, OtherWorktrees } from './other-worktrees.js';
import { MainSync } from './main-sync.js';
import { agentWorktreesFrom, cleanupText, removeAgentWorktrees } from './agent-worktree-cleanup.js';
import { claudeHome } from './claude-code/launch.js';

export interface ControllerDeps {
  readonly manager: WorkspaceManager;
  readonly store: Store;
  readonly shares: ShareService;
  readonly selfId: () => string;
  readonly toast: (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void;
  /** Ask the screen to go somewhere, open a dialog or close a tab (see core/intents.ts). */
  readonly intend: (intent: Intent) => void;
  /**
   * Ask your own Claude to do something in a workspace conversation. `echo: false` starts Claude
   * without posting the prompt as your message (it is already in the conversation).
   */
  readonly askClaude: (prompt: string, channel: string, opts?: { readonly echo?: boolean }) => void;
  /** Compact a conversation's context in your Claude's queue (falls back to asking Claude for /compact). */
  readonly compact?: (channel: string, instructions: string) => void;
  /** A Claude Code conversation in a folder (from other tools), to show and continue: the newest, or the one asked for. */
  readonly findConversation?: (dir: string, opts?: { sessionId?: string; prefer?: string }) => Promise<Conversation | undefined>;
  /** Reads Conductor's and Claude Code's data about worktrees klaud didn't make (omitted in the demo and tests). */
  readonly otherTools?: OtherTools;
  /** A new worktree exists (created, forked or handed over): e.g. run its setup. */
  readonly onWorktreeCreated?: (ws: Workspace) => void;
  /** Before a workspace is archived or deleted: stop what runs in its folder (shell, dev server). */
  readonly onWorkspaceGoing?: (id: string) => void;
  /** Claude Code's folder, where its sub-agents' worktrees are found (default: ~/.claude). */
  readonly claudeHome?: string;
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
/** What Claude starts with in a worktree you continued into without saying what to do. */
export const CONTINUE_PROMPT = 'We moved here from the main folder so you can make changes. Go ahead with what we discussed.';
const CONTINUE_WAIT_MS = 60_000;

/** The same message, ignoring spacing differences (the sheet trims and may rewrap it). */
const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

export const workspaceIdOf = (channel: string): string | undefined => (channel.startsWith(WS_PREFIX) ? channel.slice(WS_PREFIX.length) : undefined);
export { shareNameOf } from '../shared/share-names.js';
import { shareNameOf } from '../shared/share-names.js';
import { SCRATCH_DIR, type ScratchFile, ensureScratch, listScratch } from '../workspaces/scratch.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * What happened to a worktree, for whoever follows along (the board opens and closes tasks by
 * these). `from`: the workspace it was forked or continued from. `about`: what it's for, when
 * that's known as it opens (the task a conversation continued with).
 */
export type WorktreeEvent =
  | { readonly kind: 'created'; readonly ws: Workspace; readonly from?: string; readonly about?: string }
  | { readonly kind: 'merged' | 'archived' | 'removed' | 'restored'; readonly id: string };

/**
 * Connects projects and workspaces to the room: views, conversations (one Claude
 * session per workspace, history saved to disk), and every workspace action.
 */
export class WorkspaceController {
  private readonly worktreeListeners = new Set<(event: WorktreeEvent) => void>();
  private readonly loaded = new Set<string>();
  private reviewToken = 0;
  private saveTimer?: NodeJS.Timeout;
  private lastLog: readonly LogItem[] = [];
  private readonly unsubscribe: () => void;
  /** Conversations shown in worktrees from other tools, resumed when you first talk there (by workspace id). */
  private readonly pendingResume = new Map<string, string>();
  /** Worktrees klaud didn't make: who made them, their info page, tidying them away. */
  readonly others: OtherWorktrees;
  /** Keeping main folders current: fetching, Update main, and Claude's sync runs. */
  readonly mainSync: MainSync;
  /** Conversations whose next run may sync git in the main folder ("Let Claude handle it"), by workspace id. */
  private readonly syncRuns = new Map<string, { branch: string; upstream: string }>();

  /** Hear about worktrees opening, merging, going and coming back. */
  onWorktree(listener: (event: WorktreeEvent) => void): () => void {
    this.worktreeListeners.add(listener);
    return () => void this.worktreeListeners.delete(listener);
  }

  private emit(event: WorktreeEvent): void {
    for (const l of this.worktreeListeners) {
      try {
        l(event);
      } catch {
        // A listener's problem is its own.
      }
    }
  }

  /** A worktree opened: the workbench (setup) and the listeners hear of it. */
  private created(ws: Workspace, extra: { from?: string; about?: string } = {}): void {
    this.deps.onWorktreeCreated?.(ws);
    this.emit({ kind: 'created', ws, ...extra });
  }

  constructor(private readonly deps: ControllerDeps) {
    this.unsubscribe = deps.store.subscribe(() => this.scheduleSave());
    this.others = new OtherWorktrees({ manager: deps.manager, refresh: () => this.refresh(), toast: deps.toast, ...(deps.otherTools ? { tools: deps.otherTools } : {}) });
    this.mainSync = new MainSync({
      manager: deps.manager,
      refresh: () => this.refresh(),
      publish: () => this.publish(),
      toast: deps.toast,
      newChat: (projectId, title) => this.newChat(projectId, title),
      armSync: (wsId, target) => void this.syncRuns.set(wsId, target),
      askClaude: (prompt, channel) => deps.askClaude(prompt, channel),
      open: (wsId) => this.open(wsId),
    });
  }

  get manager(): WorkspaceManager {
    return this.deps.manager;
  }

  stop(): void {
    this.unsubscribe();
    this.mainSync.stop();
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
    this.publish();
  }

  /** Publish the projects as they're arranged (no re-scan: arranging is instant). */
  private publish(): void {
    const { projects, groups, order } = this.deps.manager.arrangement();
    this.deps.store.dispatch({ type: 'projects', projects, groups, order, hidden: this.deps.manager.hiddenProjects });
  }

  /** Show a workspace (chat, files, diff or terminal), loading its saved conversation the first time. */
  open(id: string, tab: WorkspaceTab = 'chat'): void {
    const ws = this.deps.manager.find(id);
    if (!ws) return this.deps.toast('That workspace no longer exists', 'warn');
    const fresh = this.ensureLoaded(id);
    // A worktree from another tool re-reads its conversation each time (it may have gone on there) until you talk in it here.
    if (fresh && !ws.sessionId && (!fresh.saved || (ws.external && this.onlyImported(`${WS_PREFIX}${id}`)))) void this.importConversation(ws.id, ws.path, `${WS_PREFIX}${id}`);
    this.deps.intend({ type: 'navigate', view: { kind: 'workspace', id, tab } });
    if (tab === 'review') void this.loadReview(id);
  }

  /**
   * Load a workspace's saved conversation (once), keeping anything already said there this
   * session (e.g. "@add-auth …" from the main chat), so it's saved from then on.
   * Returns undefined when it was already loaded.
   */
  ensureLoaded(id: string): { saved: number } | undefined {
    const channel = `${WS_PREFIX}${id}`;
    if (this.loaded.has(channel) || !this.deps.manager.find(id)) return undefined;
    this.loaded.add(channel);
    const saved = this.deps.manager.loadHistory<LogItem>(id);
    const live = this.deps.store.getState().log.filter((l) => l.channel === channel);
    const known = new Set(saved.map((l) => l.id));
    this.deps.store.dispatch({ type: 'history', channel, items: [...saved, ...live.filter((l) => !known.has(l.id))] });
    if (live.length) this.scheduleSave();
    return { saved: saved.length + live.length };
  }

  /**
   * A workspace klaud hasn't talked in yet (a worktree from Conductor, Claude Code, or your
   * main folder) shows the latest Claude Code conversation from that folder, and Claude
   * continues it from there.
   */
  private async importConversation(id: string, dir: string, channel: string, sessionId?: string): Promise<boolean> {
    try {
      const external = this.deps.manager.find(id)?.external ?? false;
      // Conductor's worktrees: the conversation Conductor has open comes first.
      const prefer = !sessionId && external ? await this.others.preferredSession(dir) : undefined;
      const found = await this.deps.findConversation?.(dir, sessionId ? { sessionId } : prefer ? { prefer } : {});
      if (!found?.items.length) return false;
      if (!this.onlyImported(channel)) return false; // you started talking meanwhile
      const when = new Date(found.lastModified).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const note: LogItem = { id: `import-${found.sessionId}`, type: 'system', channel, text: `Continuing "${found.title}" from Claude Code (last active ${when}). Claude remembers all of it.`, ts: Date.now(), level: 'info' };
      this.deps.store.dispatch({ type: 'history', channel, items: [...found.items, note] });
      // Another tool's worktree becomes yours only once you talk in it (so opening it doesn't move it in the sidebar).
      if (external) this.pendingResume.set(id, found.sessionId);
      else if (!this.deps.manager.find(id)?.sessionId) this.deps.manager.rememberSession(id, found.sessionId);
      return true;
    } catch {
      // No transcript to show: the conversation simply starts fresh.
      return false;
    }
  }

  /** Nothing said in this conversation yet except what came from Claude Code's transcript. */
  private onlyImported(channel: string): boolean {
    return this.deps.store.getState().log.every((l) => l.channel !== channel || isImportedItem(l.id));
  }

  /**
   * Show another of the Claude Code conversations that ran in a worktree from another tool
   * (Claude continues that one). Only before you've talked in it here.
   */
  async showConversation(id: string, sessionId: string): Promise<boolean> {
    const ws = this.deps.manager.find(id);
    if (!ws) return false;
    const channel = `${WS_PREFIX}${id}`;
    this.ensureLoaded(id);
    if (ws.sessionId || !this.onlyImported(channel)) {
      this.deps.toast('You’ve already talked in this worktree here, so it keeps that conversation', 'warn');
      return false;
    }
    const shown = await this.importConversation(id, ws.path, channel, sessionId);
    if (!shown) this.deps.toast('That conversation has nothing to show', 'warn');
    this.deps.intend({ type: 'navigate', view: { kind: 'workspace', id, tab: 'chat' } });
    return shown;
  }

  /** Where Claude runs for a workspace conversation: its folder, its own resumable session. */
  place(channel: string): AgentPlace | undefined {
    const id = workspaceIdOf(channel);
    const ws = id ? this.deps.manager.find(id) : undefined;
    // A folder deleted behind klaud's back: say so instead of Claude failing to start.
    if (!ws || ws.archived || !existsSync(ws.path)) return undefined;
    // "Let Claude handle it": this one run may sync git in the main folder (and nothing else).
    const syncMain = ws.askOnly ? this.syncRuns.get(ws.id) : undefined;
    if (syncMain) this.syncRuns.delete(ws.id);
    return {
      cwd: ws.path,
      additionalDirectories: [],
      // Worktrees are disposable sandboxes, so edits there don't need approval.
      autoEdit: ws.kind === 'worktree',
      // A project's main folder is questions only: work happens in worktrees.
      ...(ws.askOnly ? { askOnly: { project: this.deps.manager.list.find((p) => p.root && real(p.root) === real(ws.path))?.name ?? path.basename(ws.path) } } : {}),
      resume: ws.forkFromSession ?? ws.sessionId ?? this.pendingResume.get(ws.id),
      forkSession: Boolean(ws.forkFromSession),
      onSession: (sessionId) => this.deps.manager.rememberSession(ws.id, sessionId),
      ...(ws.model ? { model: ws.model } : {}),
      ...(syncMain ? { syncMain } : {}),
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

  /** New worktree from the latest origin default branch, or from `opts.base` (one of `branches`). */
  async newWorktree(projectId: string, name: string, opts: { base?: string } = {}): Promise<Workspace | undefined> {
    this.deps.toast(`Creating worktree "${name}" from ${opts.base ?? 'the latest origin'}…`);
    const ws = await this.act("Couldn't create the worktree", () => this.deps.manager.createWorktree(projectId, name, opts.base));
    if (ws) {
      this.deps.toast(`Worktree ${ws.name} is ready on ${ws.branch}`, 'success');
      this.open(ws.id);
      this.created(ws);
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

  /** The branches a new worktree can start from, the project's default base first. */
  branches(projectId: string): Promise<{ base: string; branches: string[] }> {
    return this.deps.manager.branches(projectId);
  }

  /**
   * Turn a draft into a worktree: it's made right away under a quick name from your first message
   * while a small model names it (then the worktree takes that name), and Claude starts on it.
   * With no message it just creates the worktree.
   */
  async startWorktree(projectId: string, firstMessage: string, nameTask: (prompt: string) => Promise<string>, opts: { base?: string; name?: string } = {}): Promise<void> {
    const text = firstMessage.trim();
    const named = opts.name?.trim();
    const proper = named || !text ? undefined : nameTask(firstMessage).catch(() => undefined);
    const ws = await this.newWorktree(projectId, named || (text ? slugify(text) : 'worktree'), opts.base ? { base: opts.base } : {});
    if (ws && text) this.deps.askClaude(firstMessage, `${WS_PREFIX}${ws.id}`);
    if (ws && proper) await this.renameWhenNamed(ws.id, proper);
  }

  /** The model's name for a worktree made under a quick one, once it arrives (never fails the start). */
  private async renameWhenNamed(id: string, proper: Promise<string | undefined>): Promise<void> {
    const name = await proper;
    if (!name) return;
    try {
      await this.deps.manager.renameWorktree(id, name);
      await this.refresh();
    } catch {
      // Keeps its quick name.
    }
  }

  /**
   * Carry a conversation into a new worktree and go on there: an ask chat in a main folder (where
   * nothing may change), or any chat. The worktree starts from the latest origin (or `base`), is
   * named by a small model after the task (or what you asked last), gets a copy of the chat and
   * a branch of Claude's conversation, and opens; Claude starts on the task there once `after`
   * resolves (the run that asked for the move has finished, so its conversation is complete).
   */
  async continueInWorktree(id: string, nameTask: (prompt: string) => Promise<string>, opts: { task?: string; base?: string; name?: string; after?: Promise<void> } = {}): Promise<Workspace | undefined> {
    const source = this.deps.manager.find(id);
    const project = source && this.deps.manager.list.find((p) => p.id === source.projectId && p.root);
    if (!source || !project) {
      this.deps.toast(source ? 'Only conversations in a project can continue in a worktree' : 'That conversation no longer exists', 'warn');
      return undefined;
    }
    const from = `${WS_PREFIX}${id}`;
    const task = opts.task?.trim();
    const asked = [...this.deps.store.getState().log].reverse().find((l) => l.channel === from && l.type === 'chat' && l.from === this.deps.selfId());
    const about = task || (asked?.type === 'chat' ? asked.text : '') || source.name;
    const proper = opts.name?.trim() ? undefined : nameTask(about).catch(() => undefined);
    const name = opts.name?.trim() || slugify(about);
    this.deps.store.dispatch({ type: 'system', channel: from, text: "Moving to a new worktree…" });
    this.saveNow(); // the copy gets everything said so far
    const made = await this.act("Couldn't create the worktree", () => this.deps.manager.fork(id, name, { base: opts.base ?? project.base }));
    if (!made) return undefined;
    // Named while it was being made; announced under its proper name.
    if (proper) await this.renameWhenNamed(made.id, proper);
    const ws = this.deps.manager.find(made.id) ?? made;
    // Claude Code looks for a conversation under the folder it runs in: bring it along.
    if (source.sessionId) carrySession(source.sessionId, source.path, ws.path);
    const to = `${WS_PREFIX}${ws.id}`;
    this.loaded.delete(to);
    this.open(ws.id);
    const where = source.askOnly ? `${project.name}'s main folder` : source.name;
    this.deps.store.dispatch({ type: 'system', channel: to, text: `Continued from “${source.name}” in ${where}, on a new branch from ${ws.base ?? project.base}. Claude remembers the conversation.` });
    this.deps.store.dispatch({ type: 'system', channel: from, text: `Continued in the worktree ${ws.name} (${ws.branch}).${source.askOnly ? ' This chat stays here for questions.' : ''}` });
    this.deps.toast(`Continuing in ${ws.name}, with the conversation so far`, 'success');
    this.created(ws, { from: id, about });
    // The task is often word-for-word what you asked last, already in the carried-over chat: start
    // Claude with it without showing it a second time.
    const repeat = Boolean(task) && asked?.type === 'chat' && sameText(asked.text, task!);
    void this.startWhen(opts.after, task || CONTINUE_PROMPT, to, !repeat);
    return ws;
  }

  /** Ask Claude in `channel` once `after` resolves (or a minute passed: never stuck behind a run that hangs). */
  private async startWhen(after: Promise<void> | undefined, prompt: string, channel: string, echo = true): Promise<void> {
    if (after) await Promise.race([after, new Promise<void>((r) => setTimeout(r, CONTINUE_WAIT_MS).unref())]);
    if (this.inChannel(channel)) this.deps.askClaude(prompt, channel, echo ? undefined : { echo: false });
  }

  async fork(id: string, name: string): Promise<Workspace | undefined> {
    const ws = await this.act("Couldn't fork", () => this.deps.manager.fork(id, name));
    if (ws) {
      this.deps.toast(`Forked into ${ws.name}, with the conversation so far`, 'success');
      this.loaded.delete(`${WS_PREFIX}${ws.id}`);
      this.open(ws.id);
      this.created(ws, { from: id });
    }
    return ws;
  }

  async archive(id: string, force = false): Promise<boolean> {
    const agents = this.agentWorktreesOf(id);
    const done = await this.act("Couldn't archive", async () => {
      this.deps.onWorkspaceGoing?.(id);
      await this.deps.manager.archive(id, force);
      return true;
    });
    if (done) {
      this.deps.intend({ type: 'close_tab', id });
      const also = await this.removeAgentWorktrees(agents);
      this.deps.toast(['Archived. The branch and conversation are kept; restore it any time.', also].filter(Boolean).join(' '), 'success');
      this.emit({ kind: 'archived', id });
    }
    return Boolean(done);
  }

  /** The worktrees sub-agents of a workspace's conversations made (they go with it). */
  private agentWorktreesOf(id: string): { root: string; list: ReturnType<typeof agentWorktreesFrom> } | undefined {
    try {
      const ws = this.deps.manager.find(id);
      const project = ws && this.deps.store.getState().projects.find((p) => p.id === ws.projectId);
      if (!ws || !project?.root || ws.kind === 'main') return undefined;
      const list = agentWorktreesFrom(ws, project, this.deps.claudeHome ?? claudeHome());
      return list.length ? { root: project.root, list } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remove them (branches kept; any working or with uncommitted changes stays) → what to say about it. */
  private async removeAgentWorktrees(agents: { root: string; list: ReturnType<typeof agentWorktreesFrom> } | undefined): Promise<string | undefined> {
    if (!agents) return undefined;
    for (const w of agents.list) this.deps.onWorkspaceGoing?.(w.id);
    const res = await removeAgentWorktrees(agents.root, agents.list, this.deps.store.getState().claudeCode.sessions);
    await this.refresh();
    return cleanupText(res);
  }

  /** Remove a worktree made outside Klaud (its branch kept), and the sub-agent worktrees made from it. */
  async removeOther(id: string, force = false): Promise<boolean> {
    const agents = this.agentWorktreesOf(id);
    const done = await this.others.remove(id, force);
    if (done) {
      const also = await this.removeAgentWorktrees(agents);
      if (also) this.deps.toast(also, 'info');
    }
    return done;
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
    if (await this.act("Couldn't restore", () => this.deps.manager.restore(id).then(() => true))) {
      this.open(id);
      this.emit({ kind: 'restored', id });
    }
  }

  async remove(id: string): Promise<void> {
    const agents = this.agentWorktreesOf(id);
    const done = await this.act("Couldn't delete", async () => {
      this.deps.onWorkspaceGoing?.(id);
      await this.deps.manager.remove(id);
      return true;
    });
    if (done) {
      this.loaded.delete(`${WS_PREFIX}${id}`);
      this.deps.intend({ type: 'close_tab', id });
      const also = await this.removeAgentWorktrees(agents);
      this.deps.toast(['Deleted.', also].filter(Boolean).join(' '), 'success');
      this.emit({ kind: 'removed', id });
    }
  }

  async commit(id: string, message = 'Work from klaud'): Promise<void> {
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
      this.emit({ kind: 'merged', id });
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

  async renameGroup(from: string, to: string): Promise<void> {
    try {
      this.deps.manager.renameGroup(from, to);
      await this.refresh();
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
    }
  }

  async ungroup(name: string): Promise<void> {
    this.deps.manager.ungroup(name);
    await this.refresh();
    this.deps.toast(`Group "${name}" removed; its projects stay`, 'success');
  }

  /** Move a project or group in the sidebar (see WorkspaceManager.arrange). False: it couldn't. */
  arrange(item: ArrangeTarget, place: { into?: string | null; before?: ArrangeTarget | null } = {}): boolean {
    try {
      this.deps.manager.arrange(item, place);
      this.publish();
      return true;
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
      return false;
    }
  }

  /** A new empty group in the sidebar (with a project moved in, if given). Its name, or undefined. */
  newGroup(name: string, opts: { before?: ArrangeTarget | null; project?: string } = {}): string | undefined {
    try {
      const made = this.deps.manager.newGroup(name, opts);
      this.publish();
      return made;
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
      return undefined;
    }
  }

  /** Show a hidden project again, back where it was. */
  async showProject(root: string): Promise<boolean> {
    try {
      this.deps.manager.showProject(root);
      await this.refresh();
      return true;
    } catch (err) {
      this.deps.toast(errorText(err), 'error');
      return false;
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
    if (this.deps.compact) return this.deps.compact(`${WS_PREFIX}${id}`, instructions);
    this.deps.askClaude(`/compact${instructions ? ` ${instructions}` : ''}`, `${WS_PREFIX}${id}`);
  }

  /** A thorough review of everything done in this workspace, posted into its chat. */
  askClaudeToReview(id: string): void {
    this.open(id);
    this.deps.askClaude(REVIEW_PROMPT, `${WS_PREFIX}${id}`);
  }

  /** A workspace's scratch folder and what's in it, newest first (nothing when it's gone). */
  async scratch(id: string): Promise<{ root: string; dir: string; files: ScratchFile[] } | undefined> {
    const ws = this.deps.manager.find(id);
    if (!ws || !existsSync(ws.path)) return undefined;
    // Made when you look (kept out of git), so there's a folder to drop things in and show in Finder.
    // (Never in a sub-agent's own worktree: that's Claude Code's, looked at, not written to.)
    if (!ws.askOnly && worktreeOrigin(ws) !== 'agent') await ensureScratch(ws.path);
    return { root: ws.path, dir: path.join(ws.path, SCRATCH_DIR), files: await listScratch(ws.path) };
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
    const token = ++this.reviewToken;
    this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, selected: 0, loading: true } });
    try {
      const data = await this.deps.manager.review(id);
      if (token !== this.reviewToken) return; // you've opened another review since
      this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, data, selected: 0, loading: false } });
      if (data.files.length) await this.selectFile(0);
    } catch (err) {
      if (token !== this.reviewToken) return;
      this.deps.store.dispatch({ type: 'review', review: { workspaceId: id, selected: 0, loading: false, error: errorText(err) } });
    }
  }

  async selectFile(index: number): Promise<void> {
    const review = this.deps.store.getState().review;
    const file = review?.data?.files[index];
    if (!review || !file) return;
    this.deps.store.dispatch({ type: 'review', review: { ...review, selected: index, diff: undefined } });
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

  /** Your workspace a conversation belongs to, if any. */
  inChannel(channel: string): Workspace | undefined {
    const id = workspaceIdOf(channel);
    return id ? this.deps.manager.find(id) : undefined;
  }
}
