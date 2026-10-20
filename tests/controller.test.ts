import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
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
import { screenOver, waitFor } from './helpers.js';
import type { ClientStore } from '../src/client/client-store.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

let store: Store;
let screen: ClientStore;
let shares: ShareService;
let ctl: WorkspaceController;
let toasts: string[];
let asked: Array<{ prompt: string; channel: string }>;
let repo: string;
let claude: string;

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-ctl-')));
  repo = path.join(base, 'code', 'app');
  claude = path.join(base, 'claude');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(base, 'app.git')], { stdio: 'pipe' });
  sh(repo, 'init', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t'); // klaud's own commits and merges need an identity (CI has none)
  sh(repo, 'config', 'user.name', 'T');
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
  const shown = screenOver(store);
  screen = shown.screen;
  ctl = new WorkspaceController({
    manager: new WorkspaceManager(wsStore),
    store,
    shares,
    selfId: () => 'me',
    toast: (t) => void toasts.push(t),
    intend: shown.intend,
    askClaude: (prompt, channel) => void asked.push({ prompt, channel }),
    claudeHome: claude,
  });
  await ctl.refresh();
});

/** A Claude Code session in `cwd` whose sub-agent made a worktree of its own (as Claude Code lays it out). */
function subAgentWorktree(cwd: string, agent: string, session = 'aaaaaaaa-0000-0000-0000-00000000000a'): string {
  const wt = path.join(repo, '.claude', 'worktrees', `agent-${agent}`);
  sh(repo, 'worktree', 'add', '-q', '-b', `worktree-agent-${agent}`, wt);
  const folder = path.join(claude, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(path.join(folder, session, 'subagents'), { recursive: true });
  writeFileSync(path.join(folder, `${session}.jsonl`), `${JSON.stringify({ type: 'user', sessionId: session, cwd, message: { content: 'go' } })}\n`);
  const meta = path.join(folder, session, 'subagents', `agent-${agent}.meta.json`);
  writeFileSync(meta, JSON.stringify({ description: agent, worktreePath: wt, worktreeBranch: `worktree-agent-${agent}` }));
  // It finished a while ago (an agent that wrote lately may still be at work).
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(meta, old, old);
  return wt;
}

const branches = (): string => sh(repo, 'branch', '--list', 'worktree-agent-*');

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

  it('starts a worktree from a chosen branch with your own name, or with no message at all', async () => {
    sh(repo, 'checkout', '-b', 'feature');
    sh(repo, 'push', '-u', 'origin', 'feature');
    sh(repo, 'checkout', 'main');
    const namer = (): Promise<string> => Promise.reject(new Error('should not be asked'));
    await ctl.startWorktree(projectId(), 'do the thing', namer, { base: 'origin/feature', name: 'mine' });
    const mine = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'mine')!;
    expect(mine).toMatchObject({ base: 'origin/feature' });
    expect(toasts).toContain('Creating worktree "mine" from origin/feature…');
    expect(toasts).not.toContain('Naming the worktree…');
    expect(asked).toEqual([{ prompt: 'do the thing', channel: `ws:${mine.id}` }]);

    await ctl.startWorktree(projectId(), '   ', namer, { name: 'quiet' });
    const quiet = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'quiet')!;
    expect(quiet).toMatchObject({ base: 'origin/main' });
    expect(asked).toHaveLength(1);
    expect(await ctl.branches(projectId())).toMatchObject({ base: 'origin/main', branches: expect.arrayContaining(['origin/main', 'feature']) });
  });

  it('makes the worktree right away while a model names it, then takes that name', async () => {
    let name!: (n: string) => void;
    const naming = new Promise<string>((r) => (name = r));
    const started = ctl.startWorktree(projectId(), 'Please fix the login redirect bug', () => naming);
    // Made and Claude started before the model answers, under a quick name from the message.
    await waitFor(() => asked.length === 1, 8000);
    const ws = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.kind === 'worktree')!;
    expect(ws).toMatchObject({ name: 'fix-login-redirect-bug', branch: 'klaud/fix-login-redirect-bug' });
    expect(asked[0]).toEqual({ prompt: 'Please fix the login redirect bug', channel: `ws:${ws.id}` });
    expect(toasts).not.toContain('Naming the worktree…');
    name('login-redirect');
    await started;
    const renamed = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.id === ws.id)!;
    expect(renamed).toMatchObject({ name: 'login-redirect', branch: 'klaud/login-redirect', path: ws.path });
    expect(sh(ws.path, 'branch', '--show-current').trim()).toBe('klaud/login-redirect');
  });

  it('keeps the quick name when naming fails', async () => {
    await ctl.startWorktree(projectId(), 'add dark mode', () => Promise.reject(new Error('offline')));
    const ws = store.getState().projects.find((p) => p.root)!.workspaces.find((w) => w.kind === 'worktree')!;
    expect(ws).toMatchObject({ name: 'add-dark-mode', branch: 'klaud/add-dark-mode' });
  });

  it('creates a worktree, opens it, runs Claude there, and saves its conversation', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'feature'))!;
    expect(screen.getState().view).toEqual({ kind: 'workspace', id: ws.id, tab: 'chat' });
    expect(ctl.inChannel(`ws:${ws.id}`)?.id).toBe(ws.id);
    expect(ctl.inChannel('room')).toBeUndefined();
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
    // An untracked file doesn't stand in the way; an uncommitted edit to a tracked one does.
    writeFileSync(path.join(repo, 'scratch.txt'), 'x');
    const tracked = path.join(repo, sh(repo, 'ls-files').split('\n')[0]!);
    const original = readFileSync(tracked, 'utf8');
    writeFileSync(tracked, `${original}edited\n`);
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.includes('uncommitted changes'))).toBe(true);
    writeFileSync(tracked, original);
    await ctl.merge(ws.id);
    expect(toasts.some((t) => t.startsWith('Merged klaud/clean'))).toBe(true);

    const fork = (await ctl.fork(ws.id, 'clean v2'))!;
    expect(fork.forkedFrom).toBe(ws.id);
    expect(ctl.place(`ws:${fork.id}`)?.forkSession).toBe(false); // parent had no Claude session yet
    expect(await ctl.archive(fork.id)).toBe(true);
    expect(screen.getState().tabs).not.toContain(fork.id);
    await ctl.restore(fork.id);
    expect(ctl.manager.find(fork.id)?.archived).toBe(false);
    await ctl.remove(fork.id);
    expect(ctl.manager.find(fork.id)).toBeUndefined();
    expect(await ctl.archive('missing')).toBe(false);
    expect(toasts.some((t) => t.startsWith("Couldn't archive"))).toBe(true);
  });

  it('archiving or deleting a conversation takes its sub-agents’ worktrees with it (branches kept; work in progress stays)', async () => {
    const ws = (await ctl.newWorktree(projectId(), 'lead'))!;
    const done = subAgentWorktree(ws.path, 'a1');
    const dirty = subAgentWorktree(ws.path, 'a2');
    writeFileSync(path.join(dirty, 'a.txt'), 'half done\n');
    const working = subAgentWorktree(ws.path, 'a3');
    // No branch (detached): its commits would be lost with it.
    const detached = subAgentWorktree(ws.path, 'a4');
    sh(detached, 'checkout', '-q', '--detach');
    // Written to just now, in a session Klaud doesn't follow: maybe still working.
    const fresh = subAgentWorktree(ws.path, 'a5');
    const now = Date.now() / 1000;
    utimesSync(path.join(claude, 'projects', ws.path.replace(/[^a-zA-Z0-9]/g, '-'), 'aaaaaaaa-0000-0000-0000-00000000000a', 'subagents', 'agent-a5.meta.json'), now, now);
    store.dispatch({ type: 'claude_code', sessions: [{ id: 's', title: 's', cwd: ws.path, status: 'working', lastAt: 1, steps: 1, agents: [{ id: 'a3', description: 'a3', type: 'general-purpose', background: true, status: 'running', startedAt: 1, lastAt: 1, steps: 1, worktree: { path: working } }] }] });
    // Another conversation's sub-agent: not this one's to remove.
    const other = (await ctl.newWorktree(projectId(), 'other'))!;
    const theirs = subAgentWorktree(other.path, 'b1', 'bbbbbbbb-0000-0000-0000-00000000000b');
    await ctl.refresh();

    expect(await ctl.archive(ws.id)).toBe(true);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(existsSync(working)).toBe(true);
    expect(existsSync(detached)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(theirs)).toBe(true);
    expect(branches()).toContain('worktree-agent-a1');
    expect(toasts.at(-1)).toBe('Archived: everything of yours is kept, uncommitted work included. Removed its 1 sub-agent worktree too (branches kept). Kept 4 sub-agent worktrees: still working, uncommitted changes or no branch.');

    await ctl.remove(other.id);
    expect(existsSync(theirs)).toBe(false);
    expect(branches()).toContain('worktree-agent-b1');
    expect(toasts.at(-1)).toBe('Deleted. Removed its 1 sub-agent worktree too (branches kept).');
    // Nothing of its own: says only what it did.
    const plain = (await ctl.newWorktree(projectId(), 'plain'))!;
    await ctl.remove(plain.id);
    expect(toasts.at(-1)).toBe('Deleted.');
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
    await ctl.renameGroup('work', 'Client work');
    expect(store.getState().projectGroups).toEqual([{ name: 'Client work', projects: [repo] }]);
    await ctl.renameGroup('nope', 'x');
    expect(toasts.at(-1)).toMatch(/No group called "nope"/);
    await ctl.ungroup('Client work');
    expect(store.getState().projectGroups).toEqual([]);
    await ctl.setGroup(projectId(), 'work');
    await ctl.setGroup(projectId(), undefined);
    expect(store.getState().projectGroups).toEqual([]);
    await ctl.hideProject(projectId());
    expect(store.getState().projects.filter((p) => p.root)).toEqual([]);
  });

  it('arranges the sidebar at once, refuses what isn’t there, and shows hidden projects again', async () => {
    expect(store.getState().projectOrder).toEqual([repo]);
    expect(ctl.newGroup('Work', { before: { project: projectId() } })).toBe('Work');
    expect(store.getState().projectOrder).toEqual(['group:Work', repo]);
    expect(store.getState().projectGroups).toEqual([{ name: 'Work', projects: [] }]);
    expect(ctl.arrange({ project: projectId() }, { into: 'Work' })).toBe(true);
    expect(store.getState().projectOrder).toEqual(['group:Work']);
    expect(store.getState().projectGroups).toEqual([{ name: 'Work', projects: [repo] }]);
    expect(ctl.arrange({ project: 'nope' }, {})).toBe(false);
    expect(toasts.at(-1)).toMatch(/Project not found/);
    expect(ctl.newGroup('Work')).toBeUndefined();
    expect(toasts.at(-1)).toMatch(/already a group/);
    await ctl.hideProject(projectId());
    expect(store.getState().hiddenProjects).toEqual([repo]);
    expect(await ctl.showProject(repo)).toBe(true);
    expect(store.getState().hiddenProjects).toEqual([]);
    expect(store.getState().projectGroups).toEqual([{ name: 'Work', projects: [repo] }]);
    expect(await ctl.showProject('/not/hidden')).toBe(false);
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
    const session = { workspaces: ctl, toast: (t: string) => void toasts.push(t), intend: (i: Parameters<ClientStore['applyIntent']>[0]) => screen.applyIntent(i), store } as unknown as Session;
    const here = (): string => (screen.getState().view.kind === 'workspace' ? `ws:${(screen.getState().view as { id: string }).id}` : 'room');
    runCommand(session, 'merge', [], here());
    expect(toasts.at(-1)).toBe('Open a workspace first (Projects on the left)');
    runCommand(session, 'new', [], here());
    expect(toasts.at(-1)).toBe('Usage: /new <name>');
    runCommand(session, 'new', ['cmd', 'test'], here());
    await waitFor(() => screen.getState().view.kind === 'workspace', 5000);
    runCommand(session, 'fork', [], here());
    expect(toasts.at(-1)).toBe('Usage: /fork <name>');
    runCommand(session, 'review', [], here());
    expect(screen.getState().view).toMatchObject({ tab: 'review' });
    runCommand(session, 'project', ['oops'], here());
    expect(toasts.at(-1)).toContain('/project add <path>');
    runCommand(session, 'overview', [], here());
    expect(screen.getState().view.kind).toBe('overview');
    runCommand(session, 'room', [], here());
    expect(screen.getState().view.kind).toBe('room');
  });
});
