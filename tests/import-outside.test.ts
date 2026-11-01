import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Never read the developer's real ~/.claude: a fake Claude Code home for this file.
const CLAUDE_HOME = mkdtempSync(path.join(os.tmpdir(), 'beluga-claude-home-'));
process.env.CLAUDE_CONFIG_DIR = CLAUDE_HOME;

const { conversationsUnder, encodeProjectDir, findConversation } = await import('../src/agent/runtime/claude/claude-sessions.js');
const { otherTools } = await import('../src/agent/other-tools.js');
const { Session } = await import('../src/core/session.js');
const { ShareService } = await import('../src/core/shares.js');
const { Store, initialState } = await import('../src/core/store.js');
const { deriveKeys, generateSecret } = await import('../src/net/crypto.js');
const { startHub } = await import('../src/net/hub.js');
const { PeerClient } = await import('../src/net/peer-client.js');
const { TerminalManager } = await import('../src/terminal/index.js');
const { WorkspaceManager } = await import('../src/workspaces/manager.js');
const { WorkspaceStore } = await import('../src/workspaces/store.js');
const { attach, waitFor } = await import('./helpers.js');
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';

/**
 * Bringing in a Claude Code conversation had outside Beluga (BLG-321): found in a folder or one
 * inside it, and continued in a new worktree where Claude resumes it, the original left alone.
 */

let counter = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

/** A Claude Code transcript, filed the way Claude Code files it. */
function writeSession(cwd: string, prompt: string, opts: { at?: number; answer?: string } = {}): string {
  const id = uuid();
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectDir(cwd));
  mkdirSync(dir, { recursive: true });
  const t0 = opts.at ?? Date.parse('2026-10-01T10:00:00Z');
  const line = (type: 'user' | 'assistant', content: unknown, i: number) =>
    JSON.stringify({ parentUuid: i ? `${id}-${i - 1}` : null, isSidechain: false, type, message: { role: type, content }, uuid: `${id}-${i}`, timestamp: new Date(t0 + i * 1000).toISOString(), cwd, sessionId: id, version: '2.1.257', userType: 'external' });
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, `${line('user', prompt, 0)}\n${line('assistant', [{ type: 'text', text: opts.answer ?? 'Sure.' }], 1)}\n`);
  if (opts.at) utimesSync(file, new Date(opts.at), new Date(opts.at));
  return id;
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-import-')));
});

describe('finding conversations under a folder', () => {
  it('lists the folder and the folders inside it, newest first, and not a look-alike sibling', async () => {
    const root = path.join(base, 'app');
    mkdirSync(path.join(root, 'packages', 'web'), { recursive: true });
    mkdirSync(`${root}-old`, { recursive: true });
    const top = writeSession(root, 'Fix the login', { at: Date.parse('2026-10-02T10:00:00Z') });
    const inner = writeSession(path.join(root, 'packages', 'web'), 'Make the button blue', { at: Date.parse('2026-10-03T10:00:00Z') });
    // "app-old" files under the same prefix as "app/old" would: its own folder decides.
    writeSession(`${root}-old`, 'Something else');
    const found = await conversationsUnder(root);
    expect(found.map((c) => c.sessionId)).toEqual([inner, top]);
    expect(found[0]).toMatchObject({ title: 'Make the button blue', cwd: path.join(root, 'packages', 'web') });
    expect(found[1]!.bytes).toBeGreaterThan(0);
  });
});

describe('continuing an outside conversation in a worktree', () => {
  const keys = deriveKeys(generateSecret());
  let hub: Awaited<ReturnType<typeof startHub>>;
  let terminals: InstanceType<typeof TerminalManager>;
  const sessions: Array<InstanceType<typeof Session>> = [];
  const home = process.env.BELUGA_HOME;

  beforeEach(async () => {
    process.env.BELUGA_HOME = path.join(base, 'beluga-home');
    terminals = new TerminalManager();
    hub = await startHub({ keys });
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.stop();
    terminals.closeAll();
    await hub?.close();
    process.env.BELUGA_HOME = home;
  });

  function repo(): string {
    const origin = path.join(base, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
    const dir = path.join(base, 'code', 'app');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-b', 'main');
    writeFileSync(path.join(dir, 'README.md'), '# app\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'init');
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '-u', 'origin', 'main');
    git(dir, 'remote', 'set-head', 'origin', 'main');
    // A commit only this folder has: the worktree starts here, not from origin.
    writeFileSync(path.join(dir, 'login.ts'), 'export {};\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'local work');
    return dir;
  }

  async function solo(dir: string) {
    const store = new Store(initialState('test', 'ask'));
    const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
    const wsStore = new WorkspaceStore(path.join(base, 'home'));
    wsStore.saveConfig({ roots: [], projects: [dir], hidden: [] });
    const workspaces = new WorkspaceManager(wsStore);
    await workspaces.refresh();
    const runs: AgentRunInput[] = [];
    const session = new Session({
      client,
      store,
      shares: new ShareService([]),
      agentCwd: base,
      workspaces,
      terminals,
      findConversation,
      otherTools,
      hasGh: async () => false,
      findPr: async () => undefined,
      open: () => undefined,
      desktopNotify: () => undefined,
      zoom: async () => ({ ok: true, message: '' }),
      copy: async () => undefined,
      saveSettings: () => undefined,
      createAgent: (): AgentBackend => ({
        nameTask: async () => 'named',
        run: async (input) => {
          runs.push(input);
          return 'Carrying on.';
        },
      }),
    });
    attach(session);
    session.start();
    sessions.push(session);
    await waitFor(() => store.getState().self, 4000);
    return { session, state: store.getState, runs, workspaces };
  }

  it('makes a worktree from the folder’s commit, shows the conversation, resumes it there and leaves the original alone', { timeout: 20_000 }, async () => {
    const dir = repo();
    const sessionId = writeSession(dir, 'Why does login fail on Safari?', { answer: 'The cookie is SameSite=Strict.' });
    const original = path.join(CLAUDE_HOME, 'projects', encodeProjectDir(dir), `${sessionId}.jsonl`);
    const before = readFileSync(original, 'utf8');
    const kay = await solo(dir);
    const ctl = kay.session.workspaces!;
    const project = kay.workspaces.list.find((p) => p.root)!;

    const listed = await ctl.outsideConversations(project.id);
    expect(listed.dir).toBe(dir);
    expect(listed.conversations.map((c) => c.sessionId)).toEqual([sessionId]);

    const bringing = ctl.importOutside(project.id, dir, sessionId, 'safari login');
    // Before any git work: its row is there already (the sheet closes; nothing waits on it).
    const row = kay.state().projects.find((p) => p.root)!.workspaces.find((w) => w.name === 'safari-login')!;
    expect(row).toMatchObject({ pending: true, kind: 'worktree' });
    const wsId = await bringing;
    expect(wsId).toBe(row.id);
    const ws = kay.workspaces.find(wsId!)!;
    expect(kay.state().projects.find((p) => p.root)!.workspaces.filter((w) => w.name === 'safari-login')).toEqual([expect.not.objectContaining({ pending: true })]);
    expect(ws).toMatchObject({ kind: 'worktree', name: 'safari-login', importedSession: sessionId, sessionId });
    expect(git(ws.path, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'HEAD'));
    // Claude Code finds it under the worktree's folder; the original is as it was.
    expect(existsSync(path.join(CLAUDE_HOME, 'projects', encodeProjectDir(realpathSync(ws.path)), `${sessionId}.jsonl`))).toBe(true);
    const channel = `ws:${ws.id}`;
    const said = () => kay.state().log.filter((l) => l.channel === channel).map((l) => ('text' in l ? l.text : ''));
    expect(said()).toEqual(expect.arrayContaining(['Why does login fail on Safari?', 'The cookie is SameSite=Strict.']));
    expect(said().some((t) => t.startsWith('On a new branch from where app is') && t.includes(dir))).toBe(true);

    kay.session.askOwnClaude('Go ahead and fix it', channel);
    await waitFor(() => kay.runs.length === 1, 4000);
    expect(kay.runs[0]!.place).toMatchObject({ cwd: ws.path, resume: sessionId });
    expect(readFileSync(original, 'utf8')).toBe(before);

    // Listed as brought in, and bringing it in again opens that worktree.
    expect((await ctl.outsideConversations(project.id)).conversations).toEqual([expect.objectContaining({ sessionId, wsId: ws.id })]);
    expect(await ctl.importOutside(project.id, dir, sessionId)).toBe(ws.id);
    expect(kay.workspaces.list.flatMap((p) => p.workspaces).filter((w) => w.importedSession)).toHaveLength(1);
  });

  it('leaves out Beluga’s own conversations in the folder', { timeout: 20_000 }, async () => {
    const dir = repo();
    const theirs = writeSession(dir, 'Outside question');
    const kay = await solo(dir);
    const project = kay.workspaces.list.find((p) => p.root)!;
    const ours = writeSession(dir, 'Asked in Beluga');
    await kay.session.workspaces!.startChat(project.id, 'Asked in Beluga');
    await waitFor(() => kay.runs.length === 1, 4000);
    const id = kay.workspaces.list.flatMap((p) => p.workspaces).find((w) => w.kind === 'chat')!.id;
    kay.workspaces.rememberSession(id, ours);
    const listed = await kay.session.workspaces!.outsideConversations(project.id);
    expect(listed.conversations.map((c) => c.sessionId)).toEqual([theirs]);
  });
});
