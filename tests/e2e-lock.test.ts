import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type E2eRun,
  alive,
  groupsUnder,
  homesFor,
  portFor,
  processesTagged,
  readLock,
  releaseLock,
  rerunArgs,
  runName,
  stopGroups,
  tryLock,
  waitForLock,
  waitingLine,
} from '../scripts/e2e-lock.mjs';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'klaud-lock-'));
const run = (over: Partial<E2eRun> = {}): E2eRun => ({ id: 'r1', pid: process.pid, name: 'KLD-39', worktree: '/w/kld-39', startedAt: Date.now(), groups: [], ...over });

/** A pid that's surely dead: a process that ran and exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      process.kill(-c.pid!, 'SIGKILL');
    } catch {
      c.kill('SIGKILL');
    }
  }
});

describe('names, ports and homes', () => {
  it('names a run after its task branch, else its worktree', () => {
    expect(runName('/w/kld-12-smarter-pr', 'klaud/kld-12-smarter-pr-polling')).toBe('KLD-12');
    expect(runName('/w/some-fix', 'main')).toBe('some-fix');
  });

  it('gives each worktree its own stable port and demo home', () => {
    expect(portFor('/w/a')).toBe(portFor('/w/a'));
    expect(portFor('/w/a')).not.toBe(portFor('/w/b'));
    expect(portFor('/w/a')).toBeGreaterThanOrEqual(14300);
    expect(portFor('/w/a')).toBeLessThan(17300);
    expect(homesFor('/w/a').home).not.toBe(homesFor('/w/b').home);
    expect(homesFor('/w/a').home.startsWith(os.tmpdir())).toBe(true);
  });
});

describe('the machine-wide lock', () => {
  it('lets one run in and says who holds it to the next', () => {
    const file = path.join(tmp(), 'lock.json');
    expect(tryLock(run(), { file })).toEqual({ ok: true });
    // Another live process (our parent) asks.
    const second = tryLock(run({ pid: process.ppid, name: 'KLD-20' }), { file });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(waitingLine(second.holder)).toMatch(/^waiting for KLD-39's e2e/);
    releaseLock(process.pid, file);
    expect(readLock(file)).toBeUndefined();
  });

  it("takes over a dead run's lock after cleaning up what it left", async () => {
    const file = path.join(tmp(), 'lock.json');
    const dead = await deadPid();
    writeFileSync(file, JSON.stringify(run({ pid: dead, name: 'KLD-3', groups: [12345] })));
    const stale: E2eRun[] = [];
    expect(tryLock(run(), { file, onStale: (old) => stale.push(old) })).toEqual({ ok: true });
    expect(stale.map((s) => s.name)).toEqual(['KLD-3']);
    expect(readLock(file)?.pid).toBe(process.pid);
  });

  it("waits, saying whose e2e it waits for, and goes once it's free", async () => {
    const file = path.join(tmp(), 'lock.json');
    writeFileSync(file, JSON.stringify(run({ pid: process.ppid, name: 'KLD-12' })));
    const said: string[] = [];
    const waiting = waitForLock(run(), { file, log: (l) => said.push(l), pollMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    expect(said[0]).toMatch(/^waiting for KLD-12's e2e/);
    expect(said).toHaveLength(1);
    // The first run ends (its owner releases the lock).
    writeFileSync(file, JSON.stringify(run({ pid: await deadPid(), name: 'KLD-12' })));
    await expect(waiting).resolves.toBe(true);
    expect(readLock(file)?.name).toBe('KLD-39');
  });

  it('gives up after its limit', async () => {
    const file = path.join(tmp(), 'lock.json');
    writeFileSync(file, JSON.stringify(run({ pid: process.ppid })));
    await expect(waitForLock(run({ name: 'KLD-1' }), { file, log: () => undefined, pollMs: 10, maxMs: 30 })).resolves.toBe(false);
  });
});

describe('teardown: nothing a run started survives it', () => {
  it('finds the groups under a process, even children that started their own', () => {
    const table = [
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 10 },
      { pid: 12, ppid: 11, pgid: 12 }, // vite, in its own group
      { pid: 13, ppid: 12, pgid: 12 },
      { pid: 20, ppid: 1, pgid: 20 }, // someone else's
    ];
    expect([...groupsUnder(10, table)].sort()).toEqual([10, 12]);
  });

  it('stops a whole process group, children included', async () => {
    const leader = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)`], { detached: true, stdio: 'ignore' });
    children.push(leader);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(leader.pid!)).toBe(true);
    await stopGroups({ groups: [leader.pid!] }, { graceMs: 1000 });
    await new Promise((r) => setTimeout(r, 100));
    let groupLeft = true;
    try {
      process.kill(-leader.pid!, 0);
    } catch {
      groupLeft = false;
    }
    expect(groupLeft).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('finds processes by the run id in their environment', async () => {
    const id = `t-${Date.now()}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, KLAUD_E2E_RUN: id }, stdio: 'ignore', detached: true });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    expect(processesTagged('KLAUD_E2E_RUN', id).map((p) => p.pid)).toContain(child.pid);
    expect(processesTagged('KLAUD_E2E_RUN', `${id}x`)).toEqual([]);
  });
});

describe('failures under load', () => {
  it('re-runs only the failed playwright tests', () => {
    expect(rerunArgs(['playwright', 'test', 'e2e/plans.spec.ts'])).toEqual(['playwright', 'test', 'e2e/plans.spec.ts', '--last-failed']);
    expect(rerunArgs(['playwright', 'test', '--last-failed'])).toEqual(['playwright', 'test', '--last-failed']);
    expect(rerunArgs(['vitest', 'run'])).toBeUndefined();
  });
});
