import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initialScreen, reduceScreen, viewFor } from '../src/client/screen.js';
import { type View, initialState } from '../src/core/store.js';
import { noticeTarget } from '../src/ui/notice-models.js';
import { chatTitleOf, migrateMainConversations } from '../src/workspaces/main-migration.js';
import { WorkspaceManager, mainId } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import type { Project, Workspace, WorkspaceRecord } from '../src/workspaces/types.js';
import { newChatProject } from '../packages/mac/src/lib/project-home.js';

/**
 * No standing main conversation per project (BLG-70): at startup, a main checkout's conversation
 * from before becomes an ordinary chat in its project, with the same history, Claude session and
 * a title; an empty one simply goes. Once only, however often it runs.
 */

const T0 = 1_760_000_000_000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

/** A project (a real git repo) whose main checkout has a conversation: two messages, a Claude session, a model and usage. */
function fixture(opts: { history?: boolean; session?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-main-migration-')));
  const root = path.join(base, 'code', 'app');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  writeFileSync(path.join(root, 'a.txt'), '1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  const store = new WorkspaceStore(path.join(base, 'home'));
  store.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  const id = mainId(root);
  const channel = `ws:${id}`;
  const main: WorkspaceRecord = {
    id,
    projectRoot: root,
    name: 'main',
    path: root,
    kind: 'main',
    createdAt: 0,
    ...(opts.session !== false ? { sessionId: 'sess-main-1' } : {}),
    model: 'opus',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, runs: 1 },
  };
  const other: WorkspaceRecord = { id: 'chat-keep', projectRoot: root, name: 'An older chat', path: root, kind: 'chat', createdAt: T0 - 1000 };
  store.saveRecords([main, other]);
  const history = [
    { id: 'm1', type: 'chat', channel, from: 'me', name: 'me', text: '  Where are the   payment routes defined?  ', ts: T0, byAgent: false },
    { id: 'a1', type: 'agent', channel, requestId: 'r1', owner: 'me', ownerName: 'me', requesterName: 'me', status: 'done', text: 'In src/routes/payments.ts.', steps: [], subagents: [], ts: T0 + 1 },
  ];
  if (opts.history !== false) store.saveHistory(id, history);
  return { base, root, store, id, history };
}

describe('migrating a project’s main conversation into a chat (BLG-70)', () => {
  it('a main conversation with history becomes a chat in its project, with its history, session, model, usage and first message as title', async () => {
    const { root, store, id, history } = fixture();
    const manager = new WorkspaceManager(store);
    await manager.refresh();
    const project = manager.list.find((p) => p.root === root)!;
    const chats = project.workspaces.filter((w) => w.kind === 'chat');
    const chat = chats.find((w) => w.id !== 'chat-keep')!;
    expect(chats).toHaveLength(2);
    expect(chat).toMatchObject({ kind: 'chat', projectRoot: root, path: root, name: 'Where are the payment routes defined?', sessionId: 'sess-main-1', model: 'opus', createdAt: T0, askOnly: true });
    expect(chat.usage).toMatchObject({ input: 10, runs: 1 });
    // The same history, now on the chat's own channel.
    const moved = manager.loadHistory<{ id: string; channel: string }>(chat.id);
    expect(moved.map((i) => i.id)).toEqual(history.map((i) => i.id));
    expect(new Set(moved.map((i) => i.channel))).toEqual(new Set([`ws:${chat.id}`]));
    // The main checkout keeps no conversation: it points at the chat, and its own file is gone.
    const main = project.workspaces.find((w) => w.kind === 'main')!;
    expect(main).toMatchObject({ id, movedTo: chat.id });
    expect(main.sessionId).toBeUndefined();
    expect(main.model).toBeUndefined();
    expect(main.usage).toBeUndefined();
    expect(existsSync(store.historyFile(id))).toBe(false);
    // Saved, so the next start finds it done.
    const saved = JSON.parse(readFileSync(path.join(store.home, 'workspaces.json'), 'utf8')).workspaces as WorkspaceRecord[];
    expect(saved.find((r) => r.id === chat.id)?.sessionId).toBe('sess-main-1');
    expect(saved.find((r) => r.id === id)?.movedTo).toBe(chat.id);
    // Going to the main checkout goes to that chat.
    expect(viewFor({ kind: 'workspace', id, tab: 'chat' }, { projects: manager.list })).toEqual({ kind: 'workspace', id: chat.id, tab: 'chat' });
  });

  it('is idempotent: starting again makes no second chat and keeps the history', async () => {
    const { root, store } = fixture();
    const first = new WorkspaceManager(store);
    await first.refresh();
    const chatId = first.list.find((p) => p.root === root)!.workspaces.find((w) => w.kind === 'chat' && w.id !== 'chat-keep')!.id;
    const recordsBefore = readFileSync(path.join(store.home, 'workspaces.json'), 'utf8');
    const again = migrateMainConversations(store, store.loadRecords());
    expect(again.changed).toBe(false);
    expect(again.moved.size).toBe(0);
    const second = new WorkspaceManager(store);
    await second.refresh();
    expect(second.list.find((p) => p.root === root)!.workspaces.filter((w) => w.kind === 'chat').map((w) => w.id).sort()).toEqual(['chat-keep', chatId].sort());
    expect(second.loadHistory(chatId)).toHaveLength(2);
    expect(readFileSync(path.join(store.home, 'workspaces.json'), 'utf8')).toBe(recordsBefore);
  });

  it('a run stopped before the old file was removed only removes it the next time', () => {
    const { store, id, history } = fixture();
    const once = migrateMainConversations(store, store.loadRecords());
    const chatId = once.moved.get(id)!;
    // As if the process died right after saving the records.
    store.saveHistory(id, history);
    const twice = migrateMainConversations(store, store.loadRecords());
    expect(twice.moved.size).toBe(0);
    expect(twice.records.filter((r) => r.kind === 'chat').map((r) => r.id).sort()).toEqual(['chat-keep', chatId].sort());
    expect(existsSync(store.historyFile(id))).toBe(false);
  });

  it('a main conversation with only a Claude session (nothing saved) still becomes a chat that resumes it', () => {
    const { store, id } = fixture({ history: false });
    const { records, moved } = migrateMainConversations(store, store.loadRecords(), { now: () => T0 + 99 });
    const chat = records.find((r) => r.id === moved.get(id))!;
    expect(chat).toMatchObject({ kind: 'chat', name: 'Chat', sessionId: 'sess-main-1', createdAt: T0 + 99 });
  });

  it('an empty main conversation simply goes: no chat is made', async () => {
    const { root, store, id } = fixture({ history: false, session: false });
    store.saveHistory(id, []);
    const manager = new WorkspaceManager(store);
    await manager.refresh();
    const project = manager.list.find((p) => p.root === root)!;
    expect(project.workspaces.filter((w) => w.kind === 'chat').map((w) => w.id)).toEqual(['chat-keep']);
    expect(project.workspaces.find((w) => w.kind === 'main')?.movedTo).toBeUndefined();
    expect(existsSync(store.historyFile(id))).toBe(false);
    // Going to it goes to the project's home.
    expect(viewFor({ kind: 'workspace', id, tab: 'chat' }, { projects: manager.list })).toEqual({ kind: 'project', id: project.id });
  });

  it('names a chat after its first message, else "Chat"', () => {
    expect(chatTitleOf([{ type: 'system', text: 'hi' }, { type: 'chat', byAgent: true, text: 'from Claude' }, { type: 'chat', byAgent: false, text: 'What\nis this?' }])).toBe('What is this?');
    expect(chatTitleOf([{ type: 'agent', prompt: 'Explain the build' }])).toBe('Explain the build');
    expect(chatTitleOf([{ type: 'chat', byAgent: false, text: 'x'.repeat(80) }])).toHaveLength(40);
    expect(chatTitleOf([])).toBe('Chat');
  });
});

describe('nothing opens a main checkout as a conversation (BLG-70)', () => {
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, projectRoot: '/r', name: id, path: `/r/${id}`, kind: 'worktree', createdAt: 0, projectId: 'p', external: false, ...over });
  const project = (main: Partial<Workspace> = {}): Project => ({ id: 'p', name: 'p', root: '/r', base: 'main', workspaces: [ws('p:main', { kind: 'main', path: '/r', ...main }), ws('wt'), ws('chat-1', { kind: 'chat', path: '/r' })] });
  const chats: Project = { id: 'chats', name: 'Chats', root: '', base: '', workspaces: [ws('solo', { kind: 'chat', projectId: 'chats', projectRoot: '' })] };

  it('going to it goes to the project’s home, or the chat its old conversation became; it never becomes a tab', () => {
    const domain = { ...initialState('room'), projects: [project()] };
    const home = reduceScreen(initialScreen, { type: 'view', view: { kind: 'workspace', id: 'p:main', tab: 'chat' } }, domain);
    expect(home.view).toEqual({ kind: 'project', id: 'p' });
    expect(home.tabs).toEqual([]);
    const moved = reduceScreen(initialScreen, { type: 'view', view: { kind: 'workspace', id: 'p:main', tab: 'chat' } }, { ...domain, projects: [project({ movedTo: 'chat-1' })] });
    expect(moved.view).toEqual({ kind: 'workspace', id: 'chat-1', tab: 'chat' });
    expect(moved.tabs).toEqual(['chat-1']);
    // Anything else goes where it said.
    expect(viewFor({ kind: 'workspace', id: 'wt', tab: 'chat' }, domain)).toEqual({ kind: 'workspace', id: 'wt', tab: 'chat' });
  });

  it('a notice from it opens the chat it became, else nothing', () => {
    expect(noticeTarget({ projects: [project()], shared: [] }, 'ws:p:main')).toBeUndefined();
    expect(noticeTarget({ projects: [project({ movedTo: 'chat-1' })], shared: [] }, 'ws:p:main')).toEqual({ kind: 'workspace', id: 'chat-1' });
  });

  it('New Chat (⌘N) in a project starts a chat on its main folder; elsewhere a chat of its own', () => {
    const projects = [chats, project()];
    const plans = { plans: [{ id: 'pl', projectId: 'p' }] } as never;
    const at = (view: View) => newChatProject({ projects, view, plans });
    expect(at({ kind: 'project', id: 'p' })).toBe('p');
    expect(at({ kind: 'workspace', id: 'wt', tab: 'chat' })).toBe('p');
    expect(at({ kind: 'draft', projectId: 'p', back: { kind: 'room' } })).toBe('p');
    expect(at({ kind: 'plan', id: 'pl' })).toBe('p');
    expect(at({ kind: 'workspace', id: 'solo', tab: 'chat' })).toBe('chats');
    expect(at({ kind: 'overview' })).toBe('chats');
  });
});
