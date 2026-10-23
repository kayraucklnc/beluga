import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ProcRow, isTestRunner, lockTargets, stopTestProcesses, testProcessesIn } from '../src/workspaces/test-procs.js';

const W = '/w/kld-5-playwright-fix';
const row = (pid: number, ppid: number, line: string): ProcRow => ({ pid, ppid, line });

describe('which processes are a worktree’s test runs', () => {
  it('judges the command, not the worktree’s name', () => {
    expect(isTestRunner(`node ${W}/node_modules/.bin/vitest run`, W)).toBe(true);
    expect(isTestRunner(`node ${W}/node_modules/@playwright/test/cli.js test`, W)).toBe(true);
    expect(isTestRunner(`node ${W}/src/server.js`, W)).toBe(false);
  });

  it("stops what this worktree's Claude started, and what's under it; not the rest", () => {
    const tag = ` KLAUD_WORKTREE=${W}`;
    const rows = [
      row(100, 1, `node ${W}/node_modules/.bin/vitest run${tag} PATH=/bin`),
      row(101, 100, 'node worker.js'), // its worker
      row(200, 1, `node ${W}/node_modules/.bin/vitest run`), // yours, in a terminal
      row(300, 1, `node ${W}/node_modules/.bin/vite --port 5173${tag}`), // a dev server Claude started and left
      row(400, 1, `node ${W}/node_modules/.bin/vite --port 14321${tag} KLAUD_E2E_RUN=1-a`), // an e2e's vite
      row(500, 1, `node /w/other/node_modules/.bin/vitest KLAUD_WORKTREE=/w/other`), // another worktree
      row(600, 1, `node /x/vitest KLAUD_WORKTREE=${W}-2`), // a worktree whose name starts the same
    ];
    expect(testProcessesIn(rows, W).sort()).toEqual([100, 101, 300, 400]);
  });

  it("stops what Claude's Bash left running, whatever it's called; never Claude Code or what it runs itself", () => {
    const tag = ` KLAUD_WORKTREE=${W}`;
    const shell = (cmd: string) => `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && eval '${cmd}' < /dev/null${tag}`;
    const rows = [
      row(10, 9, `/Applications/Klaud.app/Contents/Resources/daemon/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json${tag}`),
      row(11, 10, `node /Users/me/mcp/server.js${tag}`), // an MCP server Claude Code runs
      row(20, 10, shell('npm run dev')), // run_in_background: its shell is still there
      row(21, 20, `npm run dev${tag}`),
      row(22, 21, `node ${W}/node_modules/.bin/next dev${tag}`),
      row(12, 9, `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --output-format stream-json${tag}`),
      row(30, 1, `node server.js${tag} CLAUDE_CODE_EXECPATH=/x/claude-agent-sdk-darwin-arm64/claude`), // `node server.js &`: orphaned once the shell exited
      row(31, 30, 'node worker.js'),
      row(41, 1, `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js${tag}`),
      row(40, 1, `/Applications/Klaud.app/Contents/Resources/daemon/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json${tag}`), // a Claude Code a crash orphaned
      row(50, 1, `node server.js KLAUD_WORKTREE=/w/other`), // another worktree's
      row(60, 1, 'npm run dev'), // yours, in a terminal
    ];
    expect(testProcessesIn(rows, W).sort((a, b) => a - b)).toEqual([20, 21, 22, 30, 31]);
  });

  it('spares what was kept on purpose (KLAUD_KEEP=1) and the shell waiting on it, until the worktree goes away', () => {
    const tag = ` KLAUD_WORKTREE=${W}`;
    const shell = `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-abc.sh && eval 'KLAUD_KEEP=1 npm run dev'${tag}`;
    const rows = [
      row(20, 10, shell), // run_in_background: its shell is still there
      row(21, 20, `npm run dev${tag} KLAUD_KEEP=1`),
      row(22, 21, `node ${W}/node_modules/.bin/vite --port 5173${tag} KLAUD_KEEP=1`),
      row(30, 1, `node server.js${tag} KLAUD_KEEP=1 PATH=/bin`), // `KLAUD_KEEP=1 node server.js &`
      row(40, 1, `node other.js${tag}`), // not kept
    ];
    expect(testProcessesIn(rows, W)).toEqual([40]);
    expect(testProcessesIn(rows, W, true).sort((a, b) => a - b)).toEqual([20, 21, 22, 30, 40]);
  });

  it('never spares a test run or an e2e, even marked KLAUD_KEEP=1, nor what runs under one', () => {
    const tag = ` KLAUD_WORKTREE=${W}`;
    const rows = [
      row(10, 1, `node ${W}/node_modules/.bin/vitest run${tag} KLAUD_KEEP=1`), // a test run marked to keep
      row(20, 1, `node ${W}/scripts/e2e-lock.mjs -- playwright test${tag} KLAUD_KEEP=1`), // the e2e lock holder
      row(21, 20, `node ${W}/node_modules/.bin/vite --port 14321${tag} KLAUD_KEEP=1 KLAUD_E2E_RUN=1-a`), // its vite
      row(22, 20, `node ${W}/src/cli.ts daemon${tag} KLAUD_KEEP=1`), // its daemon: under the e2e
      row(30, 1, `node server.js${tag} KLAUD_KEEP=1`), // a server kept on purpose
    ];
    expect(testProcessesIn(rows, W).sort((a, b) => a - b)).toEqual([10, 20, 21, 22]);
  });

  it('stops every test runner installed there when the worktree goes away', () => {
    const rows = [row(200, 1, `node ${W}/node_modules/.bin/vitest run`), row(300, 1, `node ${W}/node_modules/.bin/vite`), row(700, 1, `node ${W}/server.js`)];
    expect(testProcessesIn(rows, W, true).sort()).toEqual([200, 300]);
  });
});

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

describe('a stale e2e lock never stops someone else’s process', () => {
  const run = { pid: 4100, worktree: '/w/kld-39', id: 'r9', groups: [4100, 4200], daemon: 4300, file: '/tmp/lock.json' };
  it('the lock holder verified (e2e-lock.mjs under its worktree): its groups, and its daemon when tagged', () => {
    const rows: ProcRow[] = [
      { pid: 4100, ppid: 1, line: 'node ../../scripts/e2e-lock.mjs playwright test PWD=/w/kld-39/packages/mac KLAUD_E2E_RUN=r9' },
      { pid: 4300, ppid: 4100, line: 'node src/cli.ts daemon --keep-alive demo PWD=/w/kld-39 KLAUD_E2E_RUN=r9' },
    ];
    expect(lockTargets(run, rows)).toEqual({ pids: [4100, 4300], groups: [4100, 4200] });
  });

  it('its pid reused after a reboot (another program now): nothing from the lock, groups and daemon pid included', () => {
    const rows: ProcRow[] = [
      { pid: 4100, ppid: 1, line: '/Applications/Safari.app/Contents/MacOS/Safari' },
      { pid: 4300, ppid: 1, line: '/usr/sbin/cupsd -l' },
    ];
    expect(lockTargets(run, rows)).toEqual({ pids: [], groups: [] });
    // Another worktree's e2e-lock on that pid isn't this run either.
    expect(lockTargets(run, [{ pid: 4100, ppid: 1, line: 'node scripts/e2e-lock.mjs vitest PWD=/w/kld-12' }])).toEqual({ pids: [], groups: [] });
  });

  it('a daemon pid that isn’t tagged with the run is spared even while the run is there', () => {
    const rows: ProcRow[] = [
      { pid: 4100, ppid: 1, line: 'node scripts/e2e-lock.mjs playwright test PWD=/w/kld-39/packages/mac' },
      { pid: 4300, ppid: 1, line: 'node my-own-server.js' },
    ];
    expect(lockTargets(run, rows).pids).toEqual([4100]);
  });
});

describe.runIf(process.platform === 'darwin')('stopping them for real', () => {
  it("stops a test run the worktree's Claude left, and spares the rest", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-procs-')));
    mkdirSync(path.join(dir, 'bin'));
    const runner = path.join(dir, 'bin', 'vitest.mjs');
    writeFileSync(runner, 'setInterval(() => {}, 1000);\n');
    const left = spawn(process.execPath, [runner], { env: { ...process.env, KLAUD_WORKTREE: dir }, stdio: 'ignore' });
    const yours = spawn(process.execPath, [runner], { env: { ...process.env, KLAUD_WORKTREE: '' }, stdio: 'ignore' });
    children.push(left, yours);
    await new Promise((r) => setTimeout(r, 300));
    const gone = new Promise((r) => left.on('exit', r));
    // KLAUD_E2E_DIR: not the real machine-wide lock.
    process.env.KLAUD_E2E_DIR = dir;
    expect(await stopTestProcesses(dir, { graceMs: 1000 })).toBeGreaterThanOrEqual(1);
    await gone;
    expect(yours.exitCode).toBeNull();
    delete process.env.KLAUD_E2E_DIR;
  });

  it('stops a server a Bash command left in the background (`node server.js &`), whatever its name', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-procs-')));
    const server = path.join(dir, 'server.js');
    writeFileSync(server, 'setInterval(() => {}, 1000);\n');
    const pidFile = path.join(dir, 'pid');
    // The shell exits at once; the server is orphaned (its parent becomes launchd), as after Claude's `cmd &`.
    const sh = spawn('/bin/sh', ['-c', `"${process.execPath}" "${server}" > /dev/null 2>&1 & echo $! > "${pidFile}"`], { env: { ...process.env, KLAUD_WORKTREE: dir }, stdio: 'ignore' });
    await new Promise((r) => sh.on('exit', r));
    const pid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(alive()).toBe(true);
      process.env.KLAUD_E2E_DIR = dir;
      expect(await stopTestProcesses(dir, { graceMs: 1000 })).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
      delete process.env.KLAUD_E2E_DIR;
    }
  });

  it('spares a server kept on purpose (`KLAUD_KEEP=1 node server.js &`) at the turn’s end, until the worktree goes', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-procs-')));
    const server = path.join(dir, 'server.js');
    writeFileSync(server, 'setInterval(() => {}, 1000);\n');
    const pidFile = path.join(dir, 'pid');
    const sh = spawn('/bin/sh', ['-c', `KLAUD_KEEP=1 "${process.execPath}" "${server}" > /dev/null 2>&1 & echo $! > "${pidFile}"`], { env: { ...process.env, KLAUD_WORKTREE: dir }, stdio: 'ignore' });
    await new Promise((r) => sh.on('exit', r));
    const pid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await new Promise((r) => setTimeout(r, 300));
      process.env.KLAUD_E2E_DIR = dir;
      // This turn's end, and a later one's.
      expect(await stopTestProcesses(dir, { graceMs: 300 })).toBe(0);
      expect(await stopTestProcesses(dir, { graceMs: 300 })).toBe(0);
      expect(alive()).toBe(true);
      // The worktree going away stops it too.
      expect(await stopTestProcesses(dir, { leaving: true, graceMs: 1000 })).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
      delete process.env.KLAUD_E2E_DIR;
    }
  });
});
