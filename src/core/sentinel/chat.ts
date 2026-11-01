import { randomBytes } from 'node:crypto';
import { mkdirSync, promises as fs, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dropAgentSession } from '../../agent/runtime/drop-session.js';
import { chosenAgent } from '../settings.js';
import type { AgentPlace } from '../../agent/types.js';
import { HistorySaver } from '../history-saver.js';
import { type LogItem, type Store, settleRun } from '../store.js';
import { chatFits, chatLimitMessage } from '../../shared/chat-limit.js';
import { FIRST_SENTINEL_CHAT, SENTINEL_CHAT_ID, type SentinelChats as ChatsState, sentinelChatChannel, sentinelChatOf } from './model.js';

/**
 * The Sentinel chat (docs/sentinel.md §12): conversations with your own Claude about the whole of
 * Sentinel, kept by the daemon in ~/.beluga/sentinel/chat/ (`chats.json`, and per chat its
 * history and its Claude session in `chats/<id>/`); Claude works in `work/` beside them. One is
 * open at a time; there is always one to write in (`main` first). Clear empties one and starts
 * its Claude afresh; Delete removes it for good, transcript and all. Without a folder (tests, the
 * demo) everything stays in memory. It is quiet: not a workspace, so never in the sidebar's chats
 * or Unread.
 */

export interface SentinelChatDeps {
  readonly store: Store;
  /** ~/.beluga (null: memory only). */
  readonly dir: string | null;
  readonly selfId: () => string;
  readonly now?: () => number;
  /** Claude Code's own folder (~/.claude): a deleted chat's transcript goes from there too. */
  readonly claudeDir?: string;
  /** Codex's own folder (~/.codex): a deleted chat's thread goes from there too. */
  readonly codexDir?: string;
}

/** A chat's agent session: its id and the agent it is of (none: Claude's, from before BLG-571). */
interface Saved {
  readonly sessionId?: string;
  readonly runtime?: string;
}

interface ChatsFile {
  readonly chats: ReadonlyArray<{ readonly id: string; readonly createdAt: number }>;
  readonly active: string;
}

/** The most items kept of each chat's history. */
const KEEP = 500;

export class SentinelChats {
  /** Where its Claude works. */
  readonly workDir: string;
  private readonly root: string | undefined;
  private list: ChatsFile;
  private readonly sessions = new Map<string, Saved>();
  private readonly saver: HistorySaver | undefined;
  private readonly unsubscribe: () => void;
  private lastLog: readonly LogItem[] | undefined;

  constructor(private readonly deps: SentinelChatDeps) {
    this.root = deps.dir ? path.join(deps.dir, 'sentinel', 'chat') : undefined;
    this.workDir = this.root ? path.join(this.root, 'work') : path.join(os.tmpdir(), 'beluga-sentinel-chat');
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    this.list = this.read();
    for (const c of this.list.chats) this.sessions.set(c.id, this.readState(c.id));
    this.saver = this.root
      ? new HistorySaver({
          log: () => deps.store.getState().log,
          channels: () => new Set(this.list.chats.map((c) => sentinelChatChannel(c.id))),
          idOf: (channel) => {
            const id = sentinelChatOf(channel);
            return id && this.has(id) ? id : undefined;
          },
          write: async (id, items, current) => {
            if (!this.has(id)) return;
            const file = this.chatFile(id, 'history.json');
            mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            const tmp = `${file}.${process.pid}.tmp`;
            await fs.writeFile(tmp, `${JSON.stringify(items)}\n`, { mode: 0o600 });
            if (current() && this.has(id)) renameSync(tmp, file);
            else await fs.rm(tmp, { force: true });
          },
          writeSync: (id, items) => {
            if (this.has(id)) writeJson(this.chatFile(id, 'history.json'), items);
          },
          keep: KEEP,
        })
      : undefined;
    for (const c of this.list.chats) this.load(c.id);
    this.lastLog = deps.store.getState().log;
    this.unsubscribe = deps.store.subscribe(() => {
      const log = deps.store.getState().log;
      if (log === this.lastLog) return;
      this.lastLog = log;
      this.saver?.changed();
    });
  }

  stop(): void {
    this.unsubscribe();
    this.saver?.stop();
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private chatFile(id: string, name: string): string {
    return path.join(this.root ?? this.workDir, 'chats', id, name);
  }

  has(id: string): boolean {
    return this.list.chats.some((c) => c.id === id);
  }

  /** The chats, as the state shows them. */
  state(): ChatsState {
    return { chats: this.list.chats.map((c) => ({ id: c.id, channel: sentinelChatChannel(c.id), createdAt: c.createdAt })), active: this.list.active };
  }

  /** chats.json, or the first chat when there's none yet. */
  private read(): ChatsFile {
    const listed = this.root ? readJson<Partial<ChatsFile> | undefined>(path.join(this.root, 'chats.json'), undefined) : undefined;
    const raw = Array.isArray(listed?.chats) ? listed.chats : [];
    const chats = raw.filter((c, i) => typeof c?.id === 'string' && SENTINEL_CHAT_ID.test(c.id) && raw.findIndex((x) => x?.id === c.id) === i).map((c) => ({ id: c.id, createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0 }));
    if (chats.length) return { chats, active: chats.some((c) => c.id === listed?.active) ? listed!.active! : chats[0]!.id };
    return { chats: [{ id: FIRST_SENTINEL_CHAT, createdAt: this.now }], active: FIRST_SENTINEL_CHAT };
  }

  private readState(id: string): Saved {
    if (!this.root) return {};
    const saved = readJson<{ sessionId?: unknown; runtime?: unknown }>(this.chatFile(id, 'state.json'), {});
    return { ...(typeof saved.sessionId === 'string' ? { sessionId: saved.sessionId } : {}), ...(typeof saved.runtime === 'string' ? { runtime: saved.runtime } : {}) };
  }

  private save(list: ChatsFile): void {
    this.list = list;
    if (this.root) writeJson(path.join(this.root, 'chats.json'), list);
    this.deps.store.dispatch({ type: 'sentinel_chats', chats: this.state() });
  }

  /** What one chat said before (a run cut off by a quit reads as interrupted), with anything said since. */
  private load(id: string): void {
    const channel = sentinelChatChannel(id);
    const saved = this.root ? readJson<LogItem[]>(this.chatFile(id, 'history.json'), []) : [];
    const live = this.deps.store.getState().log.filter((l) => l.channel === channel);
    const known = new Set(saved.map((l) => l.id));
    if (saved.length) this.deps.store.dispatch({ type: 'history', channel, items: [...saved.map(settleRun), ...live.filter((l) => !known.has(l.id))] });
    this.saver?.loaded(channel);
  }

  /** A new chat, after the others, open now → its id. */
  newChat(): string {
    // The same limit as Your Mac's chats (Settings › Agent › Open chats; 0: no limit).
    const limit = this.deps.store.getState().prefs.chatLimit;
    if (!chatFits(this.list.chats.length, limit)) throw new Error(chatLimitMessage(this.list.chats.length, limit, 'Sentinel chats'));
    let id = '';
    do id = randomBytes(5).toString('hex');
    while (this.has(id) || id === FIRST_SENTINEL_CHAT);
    this.sessions.set(id, {});
    this.save({ chats: [...this.list.chats, { id, createdAt: this.now }], active: id });
    this.saver?.loaded(sentinelChatChannel(id));
    return id;
  }

  /** Open a chat (which one is open is kept across restarts). */
  openChat(id: string): void {
    if (!this.has(id)) throw new Error('That chat was deleted');
    if (this.list.active !== id) this.save({ ...this.list, active: id });
  }

  /** Clear: its messages go, and its Claude starts a fresh conversation; the chat stays. */
  clear(id: string): void {
    if (!this.has(id)) throw new Error('That chat was deleted');
    const channel = sentinelChatChannel(id);
    this.deps.store.dispatch({ type: 'clear', channel });
    this.deps.store.dispatch({ type: 'context_reset', channel });
    this.forget(id);
  }

  /** A fresh Claude conversation in that chat next time. */
  private forget(id: string): void {
    this.sessions.set(id, {});
    if (this.root) writeJson(this.chatFile(id, 'state.json'), {});
  }

  /**
   * Delete a chat for good: its messages, its folder, its agent's record (Claude's transcript, Codex's thread). The one beside it opens
   * if it was the open one; deleting the last leaves a fresh empty first chat. Stopping its run first
   * is the caller's.
   */
  async deleteChat(id: string): Promise<void> {
    const at = this.list.chats.findIndex((c) => c.id === id);
    if (at < 0) return;
    const channel = sentinelChatChannel(id);
    const { sessionId, runtime } = this.sessions.get(id) ?? {};
    const rest = this.list.chats.filter((c) => c.id !== id);
    const chats = rest.length ? rest : [{ id: FIRST_SENTINEL_CHAT, createdAt: this.now }];
    const active = this.list.active !== id && rest.length ? this.list.active : chats[Math.min(at, chats.length - 1)]!.id;
    this.sessions.delete(id);
    this.list = { chats, active };
    this.deps.store.dispatch({ type: 'clear', channel });
    this.deps.store.dispatch({ type: 'context_reset', channel });
    if (this.root) await fs.rm(path.dirname(this.chatFile(id, 'x')), { recursive: true, force: true });
    if (sessionId) await dropAgentSession(this.workDir, sessionId, runtime, { ...(this.deps.claudeDir ? { claude: this.deps.claudeDir } : {}), ...(this.deps.codexDir ? { codex: this.deps.codexDir } : {}) });
    for (const c of chats) if (!this.sessions.has(c.id)) this.sessions.set(c.id, {});
    this.save(this.list);
    for (const c of chats) this.saver?.loaded(sentinelChatChannel(c.id));
  }

  /**
   * Where a chat's Claude runs: its own folder (files it makes there need no approval), its own
   * resumable session. Your runs only; a chat that's gone gets nothing (a message to the first one
   * after it was deleted brings it back, so the phone's Chat never goes nowhere).
   */
  place(channel: string, from: string): AgentPlace | undefined {
    const id = sentinelChatOf(channel);
    if (!id || from !== this.deps.selfId()) return undefined;
    if (!this.has(id)) {
      if (id !== FIRST_SENTINEL_CHAT) return undefined;
      this.save({ ...this.list, chats: [{ id, createdAt: this.now }, ...this.list.chats] });
    }
    // Your default agent, named here so its session is known to be its (another agent's can't be picked up: it starts afresh).
    const agent = chosenAgent(this.deps.store.getState().prefs);
    const was = this.sessions.get(id);
    const resume = (was?.runtime ?? 'claude') === agent.runtime ? was?.sessionId : undefined;
    return {
      cwd: this.workDir,
      additionalDirectories: [],
      autoEdit: true,
      agent,
      ...(resume ? { resume } : {}),
      onSession: (next) => {
        if (!this.has(id) || next === this.sessions.get(id)?.sessionId) return;
        const saved = { sessionId: next, runtime: agent.runtime };
        this.sessions.set(id, saved);
        if (this.root) writeJson(this.chatFile(id, 'state.json'), saved);
      },
    };
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
