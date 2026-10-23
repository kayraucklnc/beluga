import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ShareService } from '../src/core/shares.js';
import { Store, initialState } from '../src/core/store.js';
import { WorkspaceController } from '../src/core/workspace-controller.js';
import { statusSlots } from '../src/workspaces/git.js';
import { limiter } from '../src/workspaces/limit.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { askedToKeep, keepsRunning, mayLeaveProcesses } from '../src/workspaces/test-procs.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' }).toString();

describe('limiter', () => {
  it('runs at most max at once, the rest in turn, and never more after a slot is handed over', async () => {
    const limit = limiter(4);
    let now = 0;
    let most = 0;
    const done: number[] = [];
    const task = (i: number) => async () => {
      now++;
      most = Math.max(most, now);
      await new Promise((r) => setTimeout(r, 1 + (i % 3)));
      now--;
      done.push(i);
      return i;
    };
    const first = Array.from({ length: 10 }, (_, i) => limit(task(i)));
    // A newcomer arriving just as a slot frees must wait too (the slot went to the one waiting).
    await first[0];
    const late = Array.from({ length: 10 }, (_, i) => limit(task(10 + i)));
    expect(await Promise.all([...first, ...late])).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(most).toBeLessThanOrEqual(4);
    expect(limit.peak).toBe(4);
    expect(limit.active).toBe(0);
  });

  it('frees the slot when a task fails', async () => {
    const limit = limiter(1);
    await expect(limit(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(await limit(async () => 'yes')).toBe('yes');
  });
});

describe('refreshing many worktrees', () => {
  let repo: string;
  let home: string;
  let code: string;
  const trees: string[] = [];

  beforeAll(() => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-refresh-')));
    code = path.join(base, 'code');
    repo = path.join(code, 'app');
    home = path.join(base, 'home');
    mkdirSync(repo, { recursive: true });
    sh(repo, 'init', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-m', 'init');
    for (let i = 0; i < 20; i++) {
      const dir = path.join(base, 'trees', `t${i}`);
      sh(repo, 'worktree', 'add', '-b', `b${i}`, dir);
      trees.push(dir);
    }
  }, 60_000);

  const manager = () => {
    const store = new WorkspaceStore(home);
    store.saveConfig({ roots: [code], projects: [], hidden: [] });
    return new WorkspaceManager(store);
  };

  it('10 run endings in quick succession: one refresh in flight, one after, git status capped at 4', async () => {
    const mgr = manager();
    const scan = vi.spyOn(mgr as unknown as { scan: () => Promise<unknown> }, 'scan');
    const calls = Array.from({ length: 10 }, () => mgr.refresh());
    expect(scan).toHaveBeenCalledTimes(1);
    const results = await Promise.all(calls);
    // The first, then one follow-up shared by the nine made while it ran.
    expect(scan).toHaveBeenCalledTimes(2);
    expect(new Set(results.slice(1)).size).toBe(1);
    expect(mgr.list.find((p) => p.root)?.workspaces.filter((w) => w.kind === 'worktree')).toHaveLength(20);
    expect(statusSlots.peak).toBeLessThanOrEqual(4);
    expect(statusSlots.active).toBe(0);
    // Done and idle: the next call starts a fresh one.
    await mgr.refresh();
    expect(scan).toHaveBeenCalledTimes(3);
  }, 60_000);

  it("a run ending refreshes only that worktree's status", async () => {
    const mgr = manager();
    await mgr.refresh();
    const scan = vi.spyOn(mgr as unknown as { scan: () => Promise<unknown> }, 'scan');
    const before = mgr.list.find((p) => p.root)!;
    writeFileSync(path.join(trees[3]!, 'new.txt'), 'x\n');
    expect(await mgr.refreshWorkspace(trees[3]!)).toBe(true);
    const after = mgr.list.find((p) => p.root)!;
    const t3 = after.workspaces.find((w) => w.path === trees[3]);
    expect(t3?.status?.changed).toBe(1);
    // Every other workspace is the very same object: nothing else was read.
    expect(after.workspaces.filter((w) => w !== t3).every((w) => before.workspaces.includes(w))).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    // Nothing changed since: no change reported.
    expect(await mgr.refreshWorkspace(trees[3]!)).toBe(false);
    expect(await mgr.refreshWorkspace(path.join(code, 'elsewhere'))).toBe(false);
  }, 60_000);

  it('publishes a projects list only when it really changed', async () => {
    const store = new Store(initialState('room'));
    const ctl = new WorkspaceController({
      manager: manager(),
      store,
      shares: new ShareService([]),
      selfId: () => 'me',
      toast: () => undefined,
      intend: () => undefined,
      askClaude: () => undefined,
      claudeHome: path.join(home, 'claude'),
    });
    const dispatch = vi.spyOn(store, 'dispatch');
    const projectsSent = () => dispatch.mock.calls.filter(([a]) => a.type === 'projects').length;
    await ctl.refresh();
    expect(projectsSent()).toBe(1);
    const shown = store.getState().projects;
    await ctl.refresh();
    await ctl.refreshWorkspace(trees[5]!);
    expect(projectsSent()).toBe(1);
    expect(store.getState().projects).toBe(shown);
    writeFileSync(path.join(trees[5]!, 'more.txt'), 'x\n');
    await ctl.refreshWorkspace(trees[5]!);
    expect(projectsSent()).toBe(2);
    expect(store.getState().projects.flatMap((p) => p.workspaces).find((w) => w.path === trees[5])?.status?.changed).toBe(1);
    ctl.stop();
  }, 60_000);
});

describe('which commands may leave processes running', () => {
  it('test runners, e2e, dev servers, watchers and anything in the background; not everyday commands', () => {
    for (const c of ['npm test', 'npx vitest run tests/a.test.ts', 'npm run test:e2e', 'npx playwright test', 'npm run dev -- vite', 'node scripts/e2e-lock.mjs']) expect(mayLeaveProcesses(c)).toBe(true);
    // Not test-like names: a dev server, a server script, a watcher, anything put in the background.
    for (const c of ['npm run dev', 'node server.js', 'npm start', 'pnpm serve', 'tsc --watch', 'python3 -m http.server 8000', 'sleep 100 &', 'nohup ./run.sh > out.log 2>&1', 'cd app && ./bin/api & echo started'])
      expect(mayLeaveProcesses(c), c).toBe(true);
    for (const c of ['git status', 'ls -la', 'npx tsc --noEmit', 'cat src/latest.ts', 'npm run build && echo ok', 'node build.js 2>&1 | tail -5', 'make all &> build.log']) expect(mayLeaveProcesses(c), c).toBe(false);
    expect(mayLeaveProcesses('sleep 100', true)).toBe(true);
    expect(mayLeaveProcesses(undefined)).toBe(false);
  });

  it('judges what a command runs, not words in its paths or output', () => {
    // Everyday commands that only mention dev, server, test: no ps at the turn's end.
    for (const c of [
      'git status 2>/dev/null',
      'cat src/server.ts',
      'ls packages/mac/e2e 2>/dev/null | head',
      'grep -rn "startServer" src/server tests',
      'sed -n 1,40p tests/test-procs.test.ts',
      'git commit -m "start the dev server faster"',
      'echo "npm run dev"',
      'npx tsc --noEmit -p packages/mac 2>/dev/null',
      'node build.js > /dev/null 2>&1',
      'bun install',
    ])
      expect(mayLeaveProcesses(c), c).toBe(false);
    // What really starts something: in the background, or a test runner, server, watcher.
    for (const c of [
      'node server.js &',
      'node server.js > /dev/null 2>&1 &',
      'PORT=3000 npm run dev',
      'npx --yes vitest run tests/a.test.ts',
      'pnpm exec playwright test',
      'npx tsc --watch',
      'bun server.ts',
      'bun test',
      'npx tsx src/cli.tsx daemon --keep-alive demo',
      'node --test',
      'cd packages/mac && npm run test:e2e',
      'env NODE_ENV=dev nohup ./run.sh',
    ])
      expect(mayLeaveProcesses(c), c).toBe(true);
    expect(mayLeaveProcesses('cat src/server.ts', true)).toBe(true); // run_in_background
  });
});

describe('what is kept running on purpose', () => {
  it('a command that says so (KLAUD_KEEP=1)', () => {
    for (const c of ['KLAUD_KEEP=1 npm run dev &', 'cd app && KLAUD_KEEP=1 node server.js &']) expect(keepsRunning(c), c).toBe(true);
    for (const c of ['npm run dev &', 'echo KLAUD_KEEP=10', undefined]) expect(keepsRunning(c), String(c)).toBe(false);
  });

  it('a message that asks for it', () => {
    for (const p of ['Start the dev server and keep it running', 'leave the server up so I can try it', "run it, don't stop it afterwards", 'Keep vite running when you are done'])
      expect(askedToKeep(p), p).toBe(true);
    for (const p of ['Fix the flaky test', 'Stop the server', 'keep the tests short. Then run them.', undefined]) expect(askedToKeep(p), String(p)).toBe(false);
  });
});
