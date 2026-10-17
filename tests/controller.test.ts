import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../src/core/commands.js';
import type { Session } from '../src/core/session.js';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController, shareNameOf, workspaceIdOf } from '../src/core/workspace-controller.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { waitFor } from './helpers.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

let store: Store;
let shares: ShareService;
let ctl: WorkspaceController;
let toasts: string[];
let asked: Array<{ prompt: string; channel: string }>;
let repo: string;

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-ctl-')));
  repo = path.join(base, 'code', 'app');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(base, 'app.git')], { stdio: 'pipe' });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', path.join(base, 'app.git'));
  sh(repo, 'push', '-u', 'origin', 'main');
  sh(repo, 'remote', 'set-head', 'origin', 'main');
  const wsStore = new WorkspaceStore(path.join(base, 'home'));
  wsStore.saveConfig({ roots: [path.join(base, 'code')], projects: [], hidden: [] });
  store = new Store(initialState('room'));
  shares = new ShareService([]);
  toasts = [];
  asked = [];
  ctl = new WorkspaceController({
    manager: new WorkspaceManager(wsStore),
    store,
    shares,
    selfId: () => 'me',
    toast: (t) => void toasts.push(t),
    askClaude: (prompt, channel) => void asked.push({ prompt, channel }),
  });
  await ctl.refresh();
});

const projectId = () => store.getState().projects.find((p) => p.root)!.id;

describe('WorkspaceController', () => {
  it('publishes projects and makes every workspace a private share', () => {
    const app = store.getState().projects.find((p) => p.root)!;
    const main = app.workspaces[0]!;
    expect(app.name).toBe('app');
    expect(shares.canAccess(shareNameOf(main.id), 'me', 'me')).toBe(true);
    expect(shares.canAccess(shareNameOf(main.id), 'bob', 'me')).toBe(false);
    expect(shares.infos).toEqual([]); // never advertised to the room
  });

  it('creates a worktree, opens it, runs Claude there, and saves its conversation', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'feature'))!;
    expect(store.getState().view).toEqual({ kind: 'workspace', id: ws.id, tab: 'chat' });
    expect(ctl.current()?.id).toBe(ws.id);
    expect(ctl.isCurrentChannel(`ws:${ws.id}`)).toBe(true);
    const place = ctl.place(`ws:${ws.id}`)!;
    expect(place).toMatchObject({ cwd: ws.path, autoEdit: true, resume: undefined, forkSession: false });
    place.onSession('sess-1');
    expect(ctl.place(`ws:${ws.id}`)?.resume).toBe('sess-1');
    expect(ctl.place('room')).toBeUndefined();
    store.dispatch({ type: 'chat', id: 'm1', from: 'me', text: 'build it', ts: 1, byAgent: false, channel: `ws:${ws.id}` });
    await waitFor(() => ctl.manager.loadHistory(ws.id).length === 1, 3000);
    ctl.stop();
  });

  it('reviews, commits and merges; on conflicts it hands off to Claude', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'change'))!;
    writeFileSync(path.join(ws.path, 'a.txt'), 'two\n');
    await ctl.commit(ws.id, 'edit a');
    expect(toasts).toContain('Committed all changes');
    await ctl.commit(ws.id);
    expect(toasts).toContain('Nothing to commit');
    ctl.open(ws.id, 'review');
    await waitFor(() => store.getState().review?.diff?.includes('+two'), 5000);
    expect(store.getState().review?.data?.files.map((f) => f.path)).toEqual(['a.txt']);
    await ctl.selectFile(5); // out of range is ignored
    sh(repo, 'commit', '--allow-empty', '-m', 'noop');
    writeFileSync(path.join(repo, 'a.txt'), 'three\n');
    sh(repo, 'commit', '-am', 'main edit');
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.includes('Merge conflict in 1 file'))).toBe(true);
    expect(store.getState().conflicts[ws.id]).toEqual(['a.txt']); // shown as a banner with "Solve conflict"
    expect(asked).toHaveLength(0); // nothing happens until you click it
    ctl.askClaudeToMerge(ws.id);
    expect(asked[0]?.prompt).toContain(`Merge branch ${ws.branch}`);
    expect(asked[0]?.prompt).toContain('Conflicting files: a.txt');
    expect(asked[0]?.channel).toBe(`ws:${ws.id}`);
    ctl.askClaudeToReview(ws.id);
    expect(asked[1]?.prompt).toMatch(/security/i);
    expect(asked[1]?.prompt).toContain('ready to merge');
  });

  it('merges cleanly, refuses a dirty main folder, forks, archives, restores and deletes', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'clean'))!;
    writeFileSync(path.join(ws.path, 'b.txt'), 'b\n');
    await ctl.commit(ws.id);
    writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.includes('uncommitted changes'))).toBe(true);
    execFileSync('rm', [path.join(repo, 'dirty.txt')]);
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.startsWith('Merged klaud/clean'))).toBe(true);

    const fork = (await ctl.fork(ws.id, 'clean v2'))!;
    expect(fork.forkedFrom).toBe(ws.id);
    expect(ctl.place(`ws:${fork.id}`)?.forkSession).toBe(false); // parent had no Claude session yet
    expect(await ctl.archive(fork.id)).toBe(true);
    expect(store.getState().tabs).not.toContain(fork.id);
    await ctl.restore(fork.id);
    expect(ctl.manager.find(fork.id)?.archived).toBe(false);
    await ctl.remove(fork.id);
    expect(ctl.manager.find(fork.id)).toBeUndefined();
    expect(await ctl.archive('missing')).toBe(false);
    expect(toasts.some((t) => t.startsWith("Couldn't archive"))).toBe(true);
  });

  it('turns a draft into a chat with the first message, in the folder klaud started in', async () => {
    const launch = path.dirname(repo);
    await ctl.startChat('chats', 'explain   this repo please', launch);
    const chat = store.getState().projects.find((p) => p.id === 'chats')!.workspaces[0]!;
    expect(chat).toMatchObject({ name: 'explain this repo please', path: launch, kind: 'chat' });
    expect(asked.at(-1)).toEqual({ prompt: 'explain   this repo please', channel: `ws:${chat.id}` });
    await ctl.remove(chat.id);
    expect(existsSync(launch)).toBe(true); // never deletes a folder you started a chat in
  });

  it('organizes projects into groups and hides them', async () => {
    await ctl.setGroup(projectId(), 'work');
    expect(store.getState().projectGroups).toEqual([{ name: 'work', projects: [repo] }]);
    await ctl.setGroup(projectId(), undefined);
    expect(store.getState().projectGroups).toEqual([]);
    await ctl.hideProject(projectId());
    expect(store.getState().projects.filter((p) => p.root)).toEqual([]);
  });

  it('starts chats and adds projects or folders', async () => {
    const chat = (await ctl.newChat(projectId(), 'Question'))!;
    expect(chat.kind).toBe('chat');
    expect(ctl.place(`ws:${chat.id}`)?.autoEdit).toBe(false);
    await ctl.addProject('/definitely/not/here');
    expect(toasts.at(-1)).toMatch(/not a git project/);
    await ctl.addFolder(path.dirname(repo));
    expect(toasts.at(-1)).toMatch(/1 project/);
    ctl.openInFinder('missing');
    expect(toasts.at(-1)).toMatch(/no longer exists/);
    ctl.open('missing');
    expect(workspaceIdOf('ws:abc')).toBe('abc');
    expect(workspaceIdOf('room')).toBeUndefined();
  });

  it('runs workspace commands against the current workspace', async () => {
    const session = { workspaces: ctl, toast: (t: string) => void toasts.push(t), store } as unknown as Session;
    runCommand(session, 'merge', []);
    expect(toasts.at(-1)).toBe('Open a workspace first (Projects on the left)');
    runCommand(session, 'new', []);
    expect(toasts.at(-1)).toBe('Usage: /new <name>');
    runCommand(session, 'new', ['cmd', 'test']);
    await waitFor(() => store.getState().view.kind === 'workspace', 5000);
    runCommand(session, 'fork', []);
    expect(toasts.at(-1)).toBe('Usage: /fork <name>');
    runCommand(session, 'review', []);
    expect(store.getState().view).toMatchObject({ tab: 'review' });
    runCommand(session, 'project', ['oops']);
    expect(toasts.at(-1)).toContain('/project add <path>');
    runCommand(session, 'overview', []);
    expect(store.getState().view.kind).toBe('overview');
    runCommand(session, 'room', []);
    expect(store.getState().view.kind).toBe('room');
  });
});
