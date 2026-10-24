import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { WorkspaceStore } from './store.js';
import type { WorkspaceRecord } from './types.js';

/**
 * No standing "main" conversation per project (BLG-70). A project's conversations are the chats
 * and worktrees you start; its main checkout is the project's home, not a conversation. This runs
 * once at startup: a main checkout's conversation from before (saved messages, or a Claude
 * session) becomes an ordinary chat in its project, with its history, Claude session, model and
 * usage, titled after its first message. An empty one simply goes.
 *
 * Idempotent: the main record keeps `movedTo` (the chat it became) and no conversation of its own,
 * so a second run has nothing to move. Crash-safe: the chat's history is written before the
 * records, and the main's own file is removed last (a run that finds it again, already in the
 * chat, only removes it).
 */

interface HistoryItem {
  readonly id?: string;
  readonly type?: string;
  readonly channel?: string;
  readonly text?: string;
  readonly prompt?: string;
  readonly byAgent?: boolean;
  readonly ts?: number;
}

/** A chat's name: its first message (as a chat started from a draft is named), else "Chat". */
export function chatTitleOf(items: readonly HistoryItem[]): string {
  const first = items.find((i) => i.type === 'chat' && !i.byAgent && i.text?.trim()) ?? items.find((i) => i.type === 'agent' && i.prompt?.trim());
  const text = (first?.type === 'chat' ? first.text : first?.prompt) ?? '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Chat';
}

export interface MainMigration {
  readonly records: WorkspaceRecord[];
  /** Main conversations that became chats: main id → chat id. */
  readonly moved: ReadonlyMap<string, string>;
  /** Whether the records changed (and were saved). */
  readonly changed: boolean;
}

/** Move every main checkout's conversation into a chat of its project (see above). Saves the records when they change. */
export function migrateMainConversations(store: WorkspaceStore, records: readonly WorkspaceRecord[], opts: { readonly newId?: () => string; readonly now?: () => number } = {}): MainMigration {
  const newId = opts.newId ?? (() => `chat-${randomUUID().slice(0, 8)}`);
  const now = opts.now ?? Date.now;
  let out = [...records];
  const moved = new Map<string, string>();
  const removeAfter: string[] = [];
  let changed = false;
  for (const main of records.filter((r) => r.kind === 'main')) {
    const file = store.historyFile(main.id);
    const items = existsSync(file) ? store.loadHistory<HistoryItem>(main.id) : [];
    // Already moved, and only its file was left behind (a run stopped before removing it).
    const into = main.movedTo ? out.find((r) => r.id === main.movedTo) : undefined;
    if (into && items.length) {
      const there = new Set(store.loadHistory<HistoryItem>(into.id).map((i) => i.id));
      if (items.every((i) => i.id !== undefined && there.has(i.id))) {
        removeAfter.push(file);
        continue;
      }
    }
    const conversation = items.length > 0 || Boolean(main.sessionId || main.forkFromSession);
    const { sessionId, forkFromSession, model, usage, ...rest } = main;
    if (!conversation) {
      // Empty: nothing to keep as a chat (its folder's usage, if any, stays with the project).
      if (existsSync(file)) removeAfter.push(file);
      if (model !== undefined) {
        out = out.map((r) => (r === main ? { ...rest, ...(usage ? { usage } : {}) } : r));
        changed = true;
      }
      continue;
    }
    const id = newId();
    const firstTs = items.find((i) => typeof i.ts === 'number')?.ts;
    const chat: WorkspaceRecord = {
      id,
      projectRoot: main.projectRoot,
      name: chatTitleOf(items),
      path: main.projectRoot || main.path,
      kind: 'chat',
      createdAt: firstTs ?? (main.createdAt || now()),
      ...(sessionId ? { sessionId } : {}),
      ...(forkFromSession ? { forkFromSession } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
    };
    // Its history first (the channel follows the chat), then the records, then the old file goes.
    if (items.length) store.saveHistory(id, items.map((i) => (i.channel ? { ...i, channel: `ws:${id}` } : i)));
    out = [...out.map((r) => (r === main ? { ...rest, movedTo: id } : r)), chat];
    moved.set(main.id, id);
    if (existsSync(file)) removeAfter.push(file);
    changed = true;
  }
  if (changed) store.saveRecords(out);
  for (const file of removeAfter) rmSync(file, { force: true });
  return { records: out, moved, changed };
}
