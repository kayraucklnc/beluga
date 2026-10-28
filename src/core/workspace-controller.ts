import { existsSync } from 'node:fs';
import type { ArchiveManifest, ArchivePhase, ArchivePreview } from '../workspaces/archive.js';
import { formatBytes } from '../workspaces/disk.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { slugify } from '../agent/namer.js';
import { carrySession } from '../agent/session-carry.js';
import type { AgentPlace } from '../agent/types.js';
import { type ArrangeTarget, type WorkspaceManager, real } from '../workspaces/manager.js';
import type { Project, Workspace } from '../workspaces/types.js';
import { type MergeResult, git } from '../workspaces/git.js';
import type { FoundConversation } from '../agent/claude-sessions.js';
import type { ShareService } from './shares.js';
import { type LogItem, type Store, type WorkspaceTab, settleRun } from './store.js';
import { type Conversation, isImportedItem } from '../agent/transcript.js';
import type { Intent } from './intents.js';
import { type OtherTools, OtherWorktrees } from './other-worktrees.js';
import { MainSync } from './main-sync.js';
import { agentWorktreesFrom, cleanupText, removeAgentWorktrees } from './agent-worktree-cleanup.js';
import { claudeHome } from './claude-code/launch.js';
import { HistorySaver } from './history-saver.js';
import { forgetViews } from './views/forget.js';
import { nothingAhead, pendingWorktree, withAhead } from './optimistic.js';

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
  /** Reads Conductor's and Claude Code's data about worktrees Beluga didn't make (omitted in the demo and tests). */
  readonly otherTools?: OtherTools;
  /** A new worktree exists (created, forked or handed over): e.g. run its setup. */
  readonly onWorktreeCreated?: (ws: Workspace) => void;
  /** Before a workspace is archived or deleted: stop what runs in its folder (shell, dev server). */
  readonly onWorkspaceGoing?: (id: string) => void;
  /** An archived worktree is back; `remake` makes again what the archive threw away (npm install…). */
  readonly onWorktreeRestored?: (ws: Workspace, remake: readonly string[]) => void;
  /** Claude Code's folder, where its sub-agents' worktrees are found (default: ~/.claude). */
  readonly claudeHome?: string;
  /** Move a folder to the Trash (Delete Project; default: the system's Trash, see workspaces/trash.ts). */
  readonly moveToTrash?: (dir: string) => Promise<void>;
}

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

/** A folder as people read it: ~/… under your home. */
const tilde = (dir: string): string => (dir.startsWith(`${os.homedir()}/`) ? `~${dir.slice(os.homedir().length)}` : dir);

/** A Claude Code conversation from outside Beluga (BLG-321); `wsId`: the worktree it was brought into. */
export interface OutsideConversation extends FoundConversation {
  readonly wsId?: string;
}

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
/** What the archive did, in words. */
export function archivedText(m: ArchiveManifest | undefined): string {
  if (!m) return 'Archived. The branch and conversation are kept; restore it any time.';
  const freed = m.freedBytes ? ` Freed ${formatBytes(m.freedBytes)} of dependencies, builds and caches (made again when you restore it).` : '';
  const left = m.leftover ? ` Some of its folder couldn’t be removed (${m.dir}): it’s set aside when you restore it, and you can delete it.` : '';
  return `Archived: everything of yours is kept, uncommitted work included.${freed}${left}`;
}

export class WorkspaceController {
  private readonly worktreeListeners = new Set<(event: WorktreeEvent) => void>();
  private readonly goingListeners = new Set<(ws: Workspace) => void>();
  private readonly loaded = new Set<string>();
  private reviewToken = 0;
  /** Saves the loaded conversations that changed (see history-saver.ts). */
  private readonly saver: HistorySaver;
  private lastLog: readonly LogItem[] = [];
  private readonly unsubscribe: () => void;
  /** Conversations shown in worktrees from other tools, resumed when you first talk there (by workspace id). */
  private readonly pendingResume = new Map<string, string>();
  /** Worktrees Beluga didn't make: who made them, their info page, tidying them away. */
  readonly others: OtherWorktrees;
  /** Keeping main folders current: fetching, Update main, and Claude's sync runs. */
  readonly mainSync: MainSync;
  /** Conversations whose next run may sync git in the main folder ("Let Claude handle it"), by workspace id. */
  private readonly syncRuns = new Map<string, { branch: string; upstream: string }>();
  /** Main-folder conversations that may edit one hidden worktree (a plan's Claude fixing a conflict there), by workspace id. */
  private readonly fixups = new Map<string, string>();
  /** What you see ahead of the disk: worktrees going and being made, projects going (see optimistic.ts). */
  private readonly ahead = nothingAhead();
  /** Archiving and deleting in one repo, one at a time (git locks its worktrees): the last job queued, by repo. */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** Archives running now, by workspace id: it shows as archived already, so Restore can come before it's done. */
  private readonly archiving = new Map<string, Promise<boolean>>();
  /** Conversations moving to a new worktree now, by id: the sheet doesn't wait, so a second Continue joins the first. */
  private readonly moving = new Map<string, Promise<Workspace | undefined>>();

  /** Hear about worktrees opening, merging, going and coming back. */
  onWorktree(listener: (event: WorktreeEvent) => void): () => void {
    this.worktreeListeners.add(listener);
    return () => void this.worktreeListeners.delete(listener);
  }

  /** Hear about a workspace about to be archived or deleted, while its folder is still there (the board keeps proof files from it). */
  onWorktreeGoing(listener: (ws: Workspace) => void): () => void {
    this.goingListeners.add(listener);
    return () => void this.goingListeners.delete(listener);
  }

  /** A workspace is about to go: its terminals close, and whoever keeps things from its folder does so now. */
  private going(id: string, closing = true): void {
    if (closing) this.deps.onWorkspaceGoing?.(id);
    const ws = this.goingListeners.size ? this.deps.manager.find(id) : undefined;
    if (!ws) return;
    for (const l of this.goingListeners) {
      try {
        l(ws);
      } catch {
        // A listener's problem is its own.
      }
    }
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
    this.saver = new HistorySaver({
      log: () => deps.store.getState().log,
      channels: () => this.loaded,
      idOf: workspaceIdOf,
      write: (id, items, current) => deps.manager.saveHistoryAsync(id, items, current),
      writeSync: (id, items) => deps.manager.saveHistory(id, items),
    });
    this.lastLog = deps.store.getState().log;
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
    this.saver.stop();
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

  /** A run in this folder ended: its git status only (not every project's), published if it changed. */
  async refreshWorkspace(dir: string): Promise<void> {
    if (await this.deps.manager.refreshWorkspace(dir)) this.publish();
  }

  /** Publish the projects as they're arranged (no re-scan: arranging is instant); nothing when nothing changed. */
  private publish(): void {
    const arranged = this.deps.manager.arrangement();
    const { groups, order } = arranged;
    const projects = withAhead(arranged.projects, this.ahead);
    const state = this.deps.store.getState();
    const hidden = this.deps.manager.hiddenProjects;
    // A fresh list equal to the one shown would only re-scan transcripts and re-render every window.
    if (isDeepStrictEqual(projects, state.projects) && isDeepStrictEqual(groups, state.projectGroups) && isDeepStrictEqual(order, state.projectOrder) && isDeepStrictEqual(hidden, state.hiddenProjects)) return;
    this.deps.store.dispatch({ type: 'projects', projects, groups, order, hidden });
  }

  /** Show a workspace (chat, files, diff or terminal), loading its saved conversation the first time. */
  open(id: string, tab: WorkspaceTab = 'chat', req?: string): void {
    const ws = this.deps.manager.find(id);
    if (!ws) return this.deps.toast('That workspace no longer exists', 'warn');
    // A project's main checkout is no conversation (BLG-70): the chat its old one became, else the project's home.
    if (ws.kind === 'main') {
      const chat = ws.movedTo ? this.deps.manager.find(ws.movedTo) : undefined;
      if (chat && !chat.archived) return this.open(chat.id, tab, req);
      return this.deps.intend({ type: 'navigate', view: { kind: 'project', id: ws.projectId } });
    }
    const fresh = this.ensureLoaded(id);
    // A worktree from another tool re-reads its conversation each time (it may have gone on there) until you talk in it here.
    if (fresh && !ws.sessionId && (!fresh.saved || (ws.external && this.onlyImported(`${WS_PREFIX}${id}`)))) void this.importConversation(ws.id, ws.path, `${WS_PREFIX}${id}`);
    // A chat with a Claude session but nothing saved here (a main folder's conversation that was only Claude Code's): its transcript.
    else if (fresh && !fresh.saved && ws.kind === 'chat' && ws.sessionId && ws.projectRoot) void this.importConversation(ws.id, ws.path, `${WS_PREFIX}${id}`, ws.sessionId);
    this.deps.intend({ type: 'navigate', view: { kind: 'workspace', id, tab }, ...(req ? { req } : {}) });
    if (tab === 'review') void this.loadReview(id);
  }

  /**
   * Load a workspace's saved conversation (once), keeping anything already said there this
   * session (e.g. "@add-auth …" from the main chat), so it's saved from then on.
   * Returns undefined when it was already loaded.
   */
  ensureLoaded(id: string): { saved: number } | undefined {
    const channel = `${WS_PREFIX}${id}`;
    // A main checkout has no conversation to load or save (BLG-70).
    if (this.loaded.has(channel) || !this.deps.manager.find(id) || this.deps.manager.find(id)?.kind === 'main') return undefined;
    this.loaded.add(channel);
    const saved = this.deps.manager.loadHistory<LogItem>(id);
    const live = this.deps.store.getState().log.filter((l) => l.channel === channel);
    // A run saved mid-way (a crash, a quit) has nothing behind it now unless it's live here: it was interrupted.
    const liveById = new Map(live.map((l) => [l.id, l]));
    const known = new Set(saved.map((l) => l.id));
    this.deps.store.dispatch({ type: 'history', channel, items: [...saved.map((l) => liveById.get(l.id) ?? settleRun(l)), ...live.filter((l) => !known.has(l.id))] });
    if (live.length) this.saver.changed();
    else this.saver.loaded(channel);
    return { saved: saved.length + live.length };
  }

  /**
   * A workspace Beluga hasn't talked in yet (a worktree from Conductor, Claude Code, or your
   * main folder) shows the latest Claude Code conversation from that folder, and Claude
   * continues it from there.
   */
  private async importConversation(id: string, dir: string, channel: string, sessionId?: string, readFrom = dir): Promise<boolean> {
    try {
      const external = this.deps.manager.find(id)?.external ?? false;
      // Conductor's worktrees: the conversation Conductor has open comes first.
      const prefer = !sessionId && external ? await this.others.preferredSession(dir) : undefined;
      const found = await this.deps.findConversation?.(readFrom, sessionId ? { sessionId } : prefer ? { prefer } : {});
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

  // ---------------------------------------------------------- conversations from outside Beluga (BLG-321)

  /**
   * The Claude Code conversations that ran in `dir` (else the project's folder) or in a folder
   * inside it, newest first: those started in Terminal, an IDE or another tool. Beluga's own are
   * left out, except one already brought in, which carries its worktree's id.
   */
  async outsideConversations(projectId: string, dir?: string): Promise<{ dir: string; conversations: OutsideConversation[] }> {
    const project = this.deps.manager.list.find((p) => p.id === projectId && p.root);
    if (!project) throw new Error('That project isn’t on this Mac');
    const where = path.resolve(dir?.trim() || project.root);
    const all = this.deps.manager.list.flatMap((p) => p.workspaces);
    const brought = new Map(all.filter((w) => w.importedSession && !w.archived).map((w) => [w.importedSession!, w.id]));
    const ours = new Set(all.flatMap((w) => [w.sessionId, w.forkFromSession]).filter((x): x is string => Boolean(x)));
    const found = (await this.deps.otherTools?.conversationsUnder(where).catch(() => [])) ?? [];
    const conversations = found
      .filter((c) => brought.has(c.sessionId) || !ours.has(c.sessionId))
      .map((c) => (brought.has(c.sessionId) ? { ...c, wsId: brought.get(c.sessionId)! } : c));
    return { dir: where, conversations };
  }

  /**
   * Go on with a conversation from outside Beluga in a new worktree of the project: on a branch
   * from the commit its folder is on (when that's this repository; else the latest origin), with
   * the conversation shown and Claude resuming it there. The original stays as it was: Claude goes
   * on in a copy. One brought in already opens its worktree. → the worktree's id.
   *
   * Given a `name`, its row shows and its page opens right away, while git makes the worktree
   * and the transcript is copied (as for a new worktree); if it can't be made, the row goes again.
   */
  async importOutside(projectId: string, dir: string, sessionId: string, name?: string): Promise<string | undefined> {
    const project = this.deps.manager.list.find((p) => p.id === projectId && p.root);
    const id = this.deps.manager.newWorktreeId();
    const early = project && name?.trim() ? slugify(name) : '';
    if (project && early) {
      this.ahead.making.set(id, pendingWorktree({ id, project, name: early }));
      this.publish();
      this.deps.intend({ type: 'navigate', view: { kind: 'workspace', id, tab: 'chat' } });
    }
    const ws = await this.bringIn(project, dir, sessionId, name, id);
    const shown = this.ahead.making.delete(id);
    this.publish();
    if (ws === id) {
      // Its page is open already (you may have gone elsewhere since: you stay there).
      if (shown) this.ensureLoaded(id);
      else this.open(id);
    } else {
      if (shown) this.deps.intend({ type: 'close_tab', id });
      if (ws) this.open(ws);
    }
    return ws;
  }

  /** importOutside's work: the new worktree gets `id`. → its id, or that of the one brought in already. */
  private async bringIn(project: Project | undefined, dir: string, sessionId: string, name: string | undefined, id: string): Promise<string | undefined> {
    const listed = project ? await this.outsideConversations(project.id, dir).catch(() => undefined) : undefined;
    const found = listed?.conversations.find((c) => c.sessionId === sessionId);
    if (!project || !found) {
      this.deps.toast('That conversation isn’t in that folder any more', 'warn');
      return undefined;
    }
    if (found.wsId) return found.wsId;
    const named = name?.trim() || slugify(found.title) || 'conversation';
    const made = await this.act("Couldn't bring the conversation in", async () => {
      const head = (await git(found.cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim();
      const same = /^[0-9a-f]{40}$/.test(head) && (await git(project.root, ['cat-file', '-e', `${head}^{commit}`]).then(() => true, () => false));
      const branch = await this.deps.manager.freeBranchName(project.root, named);
      await git(project.root, ['branch', '--no-track', '--', branch, same ? head : project.base]);
      const ws = await this.deps.manager.createWorktreeOn(project.id, named, branch, { id, importedSession: sessionId });
      // Claude Code looks for a conversation under the folder it runs in: a copy goes there.
      if (!carrySession(sessionId, found.cwd, ws.path)) throw new Error('its transcript couldn’t be copied');
      return { ws, from: same ? `where ${path.basename(found.cwd)} is (${head.slice(0, 7)})` : project.base };
    });
    if (!made) return undefined;
    const { ws } = made;
    const channel = `${WS_PREFIX}${ws.id}`;
    this.ensureLoaded(ws.id);
    // Read where it ran: the copy is filed under the worktree, but says it ran there.
    // Nothing in it to show (only tool calls, say): Claude still resumes it.
    if (!(await this.importConversation(ws.id, ws.path, channel, sessionId, found.cwd))) this.deps.manager.rememberSession(ws.id, sessionId);
    this.deps.store.dispatch({ type: 'system', channel, text: `On a new branch from ${made.from}. The conversation in ${tilde(found.cwd)} stays as it was, and so do that folder’s uncommitted changes.` });
    this.deps.toast(`Continuing “${found.title}” in ${ws.name}`, 'success');
    this.created(ws, { about: found.title });
    return ws.id;
  }

  /** Where Claude runs for a workspace conversation: its folder, its own resumable session. */
  place(channel: string): AgentPlace | undefined {
    const id = workspaceIdOf(channel);
    const ws = id ? this.deps.manager.find(id) : undefined;
    // A folder deleted behind Beluga's back: say so instead of Claude failing to start.
    // A project's main checkout is no conversation (BLG-70): Claude runs in its chats and worktrees.
    if (!ws || ws.archived || ws.kind === 'main' || !existsSync(ws.path)) return undefined;
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
      ...(ws.askOnly && this.fixups.has(ws.id) ? { fixup: this.fixups.get(ws.id)! } : {}),
    };
  }

  /** Let a main-folder conversation's runs edit `dir` (a hidden worktree with a conflict to fix), until it's lifted (undefined). */
  allowFixup(channel: string, dir: string | undefined): void {
    const id = workspaceIdOf(channel);
    if (!id) return;
    if (dir) this.fixups.set(id, dir);
    else this.fixups.delete(id);
  }

  // ------------------------------------------------------------- actions

  /** Run `job` after the ones already queued for `repo` (a failure doesn't hold the next one up). */
  private inLane<T>(repo: string, job: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(repo) ?? Promise.resolve()).then(job, job);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(repo, tail);
    void tail.then(() => {
      if (this.lanes.get(repo) === tail) this.lanes.delete(repo);
    });
    return run;
  }

  /**
   * A workspace leaves the sidebar now (archived, or gone) and its tab closes, before any of the
   * slow work. → `settle`, for when that work is over: done, the disk agrees; failed, it's back as it was.
   */
  private leaveNow(id: string, how: 'archive' | 'delete'): () => void {
    this.ahead.leaving.set(id, how);
    this.publish();
    this.deps.intend({ type: 'close_tab', id });
    return () => {
      if (this.ahead.leaving.get(id) === how) this.ahead.leaving.delete(id);
      this.publish();
    };
  }

  /** `back`: what failing put back as it was (shown after why). */
  private async act<T>(label: string, fn: () => Promise<T>, back?: string): Promise<T | undefined> {
    try {
      const result = await fn();
      await this.refresh();
      return result;
    } catch (err) {
      const why = errorText(err);
      this.deps.toast(`${label}: ${why}${back ? `${/[.!?]$/.test(why) ? '' : '.'} ${back}` : ''}`, 'error');
      return undefined;
    }
  }

  /** New worktree from the latest origin default branch, or from `opts.base` (one of `branches`). */
  /** `quiet`: made by a plan running on its own, so it doesn't take you there (nor toast). */
  /**
   * Its row shows (and, unless `quiet`, its page opens) right away, while git fetches and makes
   * the folder; the real worktree then takes the row's place under the same id. If it can't be
   * made, the row goes again and the toast says why.
   */
  async newWorktree(projectId: string, name: string, opts: { base?: string; quiet?: boolean } = {}): Promise<Workspace | undefined> {
    const project = this.deps.manager.list.find((p) => p.root !== '' && (p.id === projectId || p.root === projectId));
    const id = this.deps.manager.newWorktreeId();
    if (project) {
      this.ahead.making.set(id, pendingWorktree({ id, project, name: slugify(name) || 'worktree', ...(opts.base ? { base: opts.base } : {}) }));
      this.publish();
      if (!opts.quiet) this.deps.intend({ type: 'navigate', view: { kind: 'workspace', id, tab: 'chat' } });
    }
    const ws = await this.act("Couldn't create the worktree", () => this.deps.manager.createWorktree(projectId, name, opts.base, { id }));
    const shown = this.ahead.making.delete(id);
    this.publish();
    if (ws) {
      if (!opts.quiet) {
        this.deps.toast(`Worktree ${ws.name} is ready on ${ws.branch}`, 'success');
        // Its page is open already (you may have gone elsewhere since: you stay there).
        if (shown) this.ensureLoaded(ws.id);
        else this.open(ws.id);
      }
      this.created(ws);
    } else if (shown) {
      this.deps.intend({ type: 'close_tab', id });
    }
    return ws;
  }

  /** `quiet`: made for something else's page (a plan's conversation), so it doesn't take you there. */
  async newChat(projectId: string, title: string, inDir?: string, opts: { readonly quiet?: boolean } = {}): Promise<Workspace | undefined> {
    const ws = await this.act("Couldn't start the chat", () => this.deps.manager.createChat(projectId, title, inDir));
    if (ws && !opts.quiet) this.open(ws.id);
    return ws;
  }

  /** A chat's name changed for you (a plan's conversation follows the plan's name). */
  async renameChat(id: string, name: string): Promise<void> {
    try {
      this.deps.manager.rename(id, name);
      await this.refresh();
    } catch {
      // Keeps its name.
    }
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
  /**
   * `plan`: its Claude plans first (plan mode is on in it before the message goes). `quiet`: made
   * from elsewhere (the phone, Your Mac), so the Mac's window stays where it is. → the worktree,
   * by the name the model gave it; with `nameLater`, as soon as it's made (its id stays when the
   * name comes, so a caller that only wants the id needn't wait for the model).
   */
  async startWorktree(projectId: string, firstMessage: string, nameTask: (prompt: string) => Promise<string>, opts: { base?: string; name?: string; plan?: boolean; quiet?: boolean; nameLater?: boolean } = {}): Promise<Workspace | undefined> {
    const text = firstMessage.trim();
    const named = opts.name?.trim();
    const proper = named || !text ? undefined : nameTask(firstMessage).catch(() => undefined);
    const ws = await this.newWorktree(projectId, named || (text ? slugify(text) : 'worktree'), { ...(opts.base ? { base: opts.base } : {}), ...(opts.quiet ? { quiet: true } : {}) });
    if (ws && opts.plan) this.deps.store.dispatch({ type: 'plan_mode', channel: `${WS_PREFIX}${ws.id}`, on: true });
    if (ws && text) this.deps.askClaude(firstMessage, `${WS_PREFIX}${ws.id}`);
    if (ws && proper) {
      if (opts.nameLater) void this.renameWhenNamed(ws.id, proper);
      else await this.renameWhenNamed(ws.id, proper);
    }
    return ws ? (this.deps.manager.find(ws.id) ?? ws) : undefined;
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
   * Go on in a new worktree: an ask chat in a main folder (where nothing may change) becomes the
   * worktree itself (same chat, same Claude session); a worktree's conversation is forked into a
   * new one. The worktree starts from the latest origin (or `base`), is named by a small model
   * after the task (or what you asked last), and opens; Claude starts on the task there once
   * `after` resolves (the run that asked for the move has finished, so its conversation is complete).
   */
  async continueInWorktree(id: string, nameTask: (prompt: string) => Promise<string>, opts: { task?: string; base?: string; name?: string; after?: Promise<void> } = {}): Promise<Workspace | undefined> {
    const running = this.moving.get(id);
    if (running) return running;
    const job = this.continueNow(id, nameTask, opts);
    this.moving.set(id, job);
    try {
      return await job;
    } finally {
      this.moving.delete(id);
    }
  }

  private async continueNow(id: string, nameTask: (prompt: string) => Promise<string>, opts: { task?: string; base?: string; name?: string; after?: Promise<void> }): Promise<Workspace | undefined> {
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
    // The task is often word-for-word what you asked last, already in the conversation: start
    // Claude with it without showing it a second time.
    const repeat = Boolean(task) && asked?.type === 'chat' && sameText(asked.text, task!);
    if (source.kind === 'chat') return this.chatToWorktree(source, project, name, proper, { task, repeat, about, base: opts.base, after: opts.after });
    this.deps.store.dispatch({ type: 'system', channel: from, text: "Moving to a new worktree…" });
    this.saver.flush(); // the copy gets everything said so far
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
    this.deps.store.dispatch({ type: 'system', channel: to, text: `Continued from “${source.name}”, on a new branch from ${ws.base ?? project.base}. Claude remembers the conversation.` });
    this.deps.store.dispatch({ type: 'system', channel: from, text: `Continued in the worktree ${ws.name} (${ws.branch}).` });
    this.deps.toast(`Continuing in ${ws.name}, with the conversation so far`, 'success');
    this.created(ws, { from: id, about });
    void this.startWhen(opts.after, task || CONTINUE_PROMPT, to, !repeat);
    return ws;
  }

  /**
   * A chat in the main folder becomes the worktree itself: same conversation, same chat, same
   * Claude session, now in its own folder on a new branch. Claude's session moves along once the
   * run that asked for it has finished (so nothing it said is left behind), then it goes on.
   */
  private async chatToWorktree(
    source: Workspace,
    project: { name: string; base: string },
    name: string,
    proper: Promise<string | undefined> | undefined,
    opts: { task?: string | undefined; repeat: boolean; about: string; base?: string | undefined; after?: Promise<void> | undefined },
  ): Promise<Workspace | undefined> {
    const channel = `${WS_PREFIX}${source.id}`;
    this.deps.store.dispatch({ type: 'system', channel, text: 'Making this chat a worktree…' });
    const made = await this.act("Couldn't create the worktree", () => this.deps.manager.chatToWorktree(source.id, name, { base: opts.base ?? project.base }));
    if (!made) return undefined;
    if (proper) await this.renameWhenNamed(source.id, proper);
    const ws = this.deps.manager.find(source.id) ?? made.ws;
    this.open(ws.id);
    this.deps.store.dispatch({ type: 'system', channel, text: `This chat is now the worktree ${ws.name} (${ws.branch}), on a new branch from ${ws.base ?? project.base}. Claude remembers the conversation and can make changes.` });
    this.deps.toast(`${ws.name} is a worktree now; Claude goes on here`, 'success');
    this.created(ws, { from: source.id, about: opts.about });
    void (async () => {
      if (opts.after) await Promise.race([opts.after, new Promise<void>((r) => setTimeout(r, CONTINUE_WAIT_MS).unref())]);
      // Claude Code looks for a conversation under the folder it runs in: bring it along.
      const sessionId = this.deps.manager.find(source.id)?.sessionId;
      if (sessionId) carrySession(sessionId, made.was, ws.path);
      await this.startWhen(undefined, opts.task || CONTINUE_PROMPT, channel, !opts.repeat);
    })();
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

  /**
   * Archive smartly (see workspaces/archive.ts): nothing of yours is lost, so uncommitted work
   * no longer stops it (`_force` is from when it did). How far along shows while it runs.
   * `quiet`: a plan clearing away merged work (no toast).
   */
  async archive(id: string, _force = false, opts: { readonly quiet?: boolean } = {}): Promise<boolean> {
    const running = this.archiving.get(id);
    if (running) return running;
    const job = this.archiveNow(id, opts);
    this.archiving.set(id, job);
    try {
      return await job;
    } finally {
      this.archiving.delete(id);
    }
  }

  private async archiveNow(id: string, opts: { readonly quiet?: boolean }): Promise<boolean> {
    const agents = this.agentWorktreesOf(id);
    const ws = this.deps.manager.find(id);
    // Out of the sidebar now (it can't be archived: the manager says why); saving and removing the folder follow.
    this.going(id);
    const settle = ws && !ws.archived && ws.kind !== 'main' ? this.leaveNow(id, 'archive') : () => undefined;
    const phase = (p?: ArchivePhase): void => void this.deps.store.dispatch({ type: 'archiving', id, ...(p ? { phase: p } : {}) });
    let manifest: ArchiveManifest | undefined;
    const answers = this.answersIn(id);
    const done = await this.inLane(ws?.projectRoot || ws?.path || id, () =>
      this.act(
        "Couldn't archive",
        async () => {
          try {
            manifest = await this.deps.manager.archive(id, phase);
          } finally {
            phase();
          }
          return true;
        },
        ws ? `${ws.name} is back in the sidebar, as it was.` : undefined,
      ),
    );
    settle();
    if (done) {
      this.deps.intend({ type: 'close_tab', id });
      // The rows its views fetched go (they're fetched again if it comes back); their scripts stay.
      forgetViews(answers, 'archived');
      const also = await this.removeAgentWorktrees(agents);
      if (!opts.quiet) this.deps.toast([archivedText(manifest), also].filter(Boolean).join(' '), 'success');
      this.emit({ kind: 'archived', id });
    }
    return Boolean(done);
  }

  /** Claude's answers in a workspace's conversation (saved, and said this session): where its views are. */
  private answersIn(id: string): string[] {
    try {
      const channel = `${WS_PREFIX}${id}`;
      const items = [...this.deps.manager.loadHistory<LogItem>(id), ...this.deps.store.getState().log.filter((l) => l.channel === channel)];
      return items.flatMap((l) => (l.type === 'agent' ? [l.text] : []));
    } catch {
      return [];
    }
  }

  /** Claude's answers in every other conversation (only asked for when there are files to delete). */
  private answersElsewhere(id: string): string[] {
    const channel = `${WS_PREFIX}${id}`;
    const live = this.deps.store.getState().log.flatMap((l) => (l.type === 'agent' && l.channel !== channel ? [l.text] : []));
    const saved = this.deps.manager.list
      .flatMap((p) => p.workspaces)
      .filter((w) => w.id !== id && !this.loaded.has(`${WS_PREFIX}${w.id}`))
      .flatMap((w) => this.answersIn(w.id));
    return [...live, ...saved];
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
    for (const w of agents.list) this.going(w.id);
    const res = await removeAgentWorktrees(agents.root, agents.list, this.deps.store.getState().claudeCode.sessions);
    await this.refresh();
    return cleanupText(res);
  }

  /** Remove a worktree made outside Beluga (its branch kept), and the sub-agent worktrees made from it. */
  async removeOther(id: string, force = false): Promise<boolean> {
    const agents = this.agentWorktreesOf(id);
    // Its terminals stay until it's gone (it may be refused: uncommitted changes).
    this.going(id, false);
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

  archivePlan(id: string): Promise<ArchivePreview | undefined> {
    return this.deps.manager.archivePlan(id).catch(() => undefined);
  }

  /** Free space in a worktree you keep (its dependencies, builds and caches) → bytes freed. */
  async freeSpace(id: string): Promise<number> {
    const freed = await this.act("Couldn't free space", () => this.deps.manager.freeSpace(id));
    if (!freed) return 0;
    this.deps.toast(`Freed ${formatBytes(freed.bytes)}.${freed.remake.length ? ` Run ${freed.remake.map((r) => `\`${r}\``).join(', then ')} to work in it again.` : ''}`, 'success');
    return freed.bytes;
  }

  /** Bring it back as it was; what was thrown away is made again by the project's setup. */
  async restore(id: string): Promise<void> {
    // Still being archived (it shows as archived already): restoring now would find nothing to bring back.
    const archiving = this.archiving.get(id);
    if (archiving) {
      this.deps.toast(`Restoring ${this.deps.manager.find(id)?.name ?? 'it'} once it’s done archiving…`, 'info');
      if (!(await archiving)) return; // it never went: nothing to restore
    }
    const ws = this.deps.manager.find(id);
    let manifest: ArchiveManifest | undefined;
    // In the repo's lane, like archiving and deleting (git locks its worktrees).
    const done = await this.inLane(ws?.projectRoot || ws?.path || id, () =>
      this.act("Couldn't restore", async () => {
        manifest = await this.deps.manager.restore(id);
        return true;
      }),
    );
    if (!done) return;
    this.open(id);
    this.emit({ kind: 'restored', id });
    const back = this.deps.manager.find(id);
    if (back && manifest?.dropped.length) this.deps.onWorktreeRestored?.(back, manifest.remake);
  }

  async remove(id: string): Promise<void> {
    const agents = this.agentWorktreesOf(id);
    const ws = this.deps.manager.find(id);
    // Gone from the sidebar now; the folder, its branch and the conversation follow.
    this.going(id);
    const settle = ws && ws.kind !== 'main' ? this.leaveNow(id, 'delete') : () => undefined;
    const answers = this.answersIn(id);
    const done = await this.inLane(ws?.projectRoot || ws?.path || id, () =>
      this.act(
        "Couldn't delete",
        async () => {
          await this.deps.manager.remove(id);
          return true;
        },
        ws ? `${ws.name} is back in the sidebar, as it was.` : undefined,
      ),
    );
    settle();
    if (done) {
      this.loaded.delete(`${WS_PREFIX}${id}`);
      this.deps.intend({ type: 'close_tab', id });
      // Its views' rows go, and their scripts and handed-over rows unless another conversation shows them.
      forgetViews(answers, 'deleted', () => this.answersElsewhere(id));
      const also = await this.removeAgentWorktrees(agents);
      this.deps.toast(['Deleted.', also].filter(Boolean).join(' '), 'success');
      this.emit({ kind: 'removed', id });
    }
  }

  async commit(id: string, message = 'Work from Beluga'): Promise<void> {
    const committed = await this.act("Couldn't commit", () => this.deps.manager.commitAll(id, message));
    if (committed !== undefined) this.deps.toast(committed ? 'Committed all changes' : 'Nothing to commit', committed ? 'success' : 'info');
  }

  /** Merge into the main folder; on conflicts, hand the job to Claude. */
  /** Merge a worktree into its main folder. → how it went (undefined: it couldn't be tried; a toast says why). */
  async merge(id: string): Promise<MergeResult | undefined> {
    const ws = this.deps.manager.find(id);
    if (!ws) return undefined;
    const result = await this.act("Couldn't merge", () => this.deps.manager.merge(id));
    if (!result) return undefined;
    this.deps.store.dispatch({ type: 'conflicts', id, files: !result.ok && result.reason === 'conflict' ? result.files : [] });
    if (result.ok) {
      this.deps.toast(`Merged ${ws.branch} into the main folder`, 'success');
      this.emit({ kind: 'merged', id });
      return result;
    }
    if (result.reason === 'wrong_branch') {
      this.deps.toast(`The main folder is on ${result.current}, not ${result.expected}. Switch it to ${result.expected} first.`, 'warn');
      return result;
    }
    if (result.reason === 'dirty') {
      this.deps.toast(`The main folder has uncommitted changes (${result.files.slice(0, 3).join(', ')}). Commit or stash them first.`, 'warn');
      return result;
    }
    this.deps.toast(`Merge conflict in ${result.files.length} file(s). Click "Solve merge conflict" to let Claude handle it.`, 'warn');
    return result;
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

  /**
   * Delete Project: it leaves Beluga (its worktrees archived first, losslessly); with `trash`, its
   * folder goes to the Trash too. False: it couldn't (and says why).
   */
  async removeProject(projectId: string, trash = false): Promise<boolean> {
    const project = this.deps.manager.list.find((p) => p.id === projectId);
    // Stop what runs in its folders (shells, dev servers) and close their tabs first.
    for (const w of project?.workspaces.filter((x) => !x.archived) ?? []) {
      this.going(w.id);
      this.deps.intend({ type: 'close_tab', id: w.id });
    }
    // Out of the sidebar now; archiving its worktrees follows (if that fails, it's back).
    if (project) {
      this.ahead.projects.add(projectId);
      this.publish();
    }
    const phase = (id: string, p?: ArchivePhase): void => void this.deps.store.dispatch({ type: 'archiving', id, ...(p ? { phase: p } : {}) });
    const res = await this.inLane(project?.root || projectId, () =>
      this.act(
        "Couldn't delete the project",
        () => this.deps.manager.removeProject(projectId, { trash, onPhase: phase, ...(this.deps.moveToTrash ? { toTrash: this.deps.moveToTrash } : {}) }),
        project ? `${project.name} is back in the sidebar.` : undefined,
      ),
    );
    this.ahead.projects.delete(projectId);
    this.publish();
    if (!res) return false;
    const kept = res.archived ? ` ${res.archived} worktree${res.archived === 1 ? '' : 's'} archived (nothing lost).` : '';
    this.deps.toast(`Removed ${project?.name ?? 'the project'} from Beluga.${res.trashed ? ' Its folder is in the Trash.' : ''}${kept}`, 'success');
    return true;
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
    this.saver.changed();
  }

  /** Your workspace a conversation belongs to, if any. */
  inChannel(channel: string): Workspace | undefined {
    const id = workspaceIdOf(channel);
    return id ? this.deps.manager.find(id) : undefined;
  }

  /** A worktree whose row shows but git is still making (see newWorktree). */
  isMaking(channel: string): boolean {
    const id = workspaceIdOf(channel);
    return id !== undefined && this.ahead.making.has(id);
  }
}
