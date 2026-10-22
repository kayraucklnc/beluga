import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ProcRow, isTestRunner, stopTestProcesses, testProcessesIn } from '../src/workspaces/test-procs.js';

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
      row(300, 1, `node ${W}/node_modules/.bin/vite --port 5173${tag}`), // a dev server Claude started
      row(400, 1, `node ${W}/node_modules/.bin/vite --port 14321${tag} KLAUD_E2E_RUN=1-a`), // an e2e's vite
      row(500, 1, `node /w/other/node_modules/.bin/vitest KLAUD_WORKTREE=/w/other`), // another worktree
      row(600, 1, `node /x/vitest KLAUD_WORKTREE=${W}-2`), // a worktree whose name starts the same
    ];
    expect(testProcessesIn(rows, W).sort()).toEqual([100, 101, 400]);
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
});
