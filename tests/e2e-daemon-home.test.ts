import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MARK, freshHome, portProblem, stopDaemon } from '../packages/mac/e2e/daemon.js';
import { alive } from '../scripts/e2e-lock.mjs';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'klaud-e2e-home-'));

/** A process that looks like a klaud daemon (its command line says so). */
function fakeDaemon(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'daemon', '--keep-alive', 'demo'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

const waitFor = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
};

describe('a stale demo home', () => {
  it('stops the daemon an interrupted run left and empties the home', async () => {
    const home = tmp();
    writeFileSync(path.join(home, MARK), '');
    const old = fakeDaemon();
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ pid: old.pid, port: 1 }));
    writeFileSync(path.join(home, 'board.json'), '{}');
    const said = await freshHome(home);
    expect(said.join()).toMatch(`stopped the demo daemon pid ${old.pid}`);
    await waitFor(() => !alive(old.pid!));
    expect(alive(old.pid!)).toBe(false);
    expect(existsSync(path.join(home, 'daemon.json'))).toBe(false);
    expect(existsSync(path.join(home, 'board.json'))).toBe(false);
    expect(existsSync(path.join(home, MARK))).toBe(true);
  });

  it('removes a daemon.json or lock whose process is gone', async () => {
    const home = tmp();
    writeFileSync(path.join(home, MARK), '');
    writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ pid: 999_999 }));
    writeFileSync(path.join(home, 'daemon.lock'), '999998');
    expect(await freshHome(home)).toEqual(['removed a stale daemon.json', 'removed a stale daemon.lock']);
    expect(existsSync(path.join(home, 'daemon.lock'))).toBe(false);
  });

  it("never stops a process that isn't a daemon (a reused pid)", async () => {
    const home = tmp();
    writeFileSync(path.join(home, MARK), '');
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(other);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ pid: other.pid }));
    await freshHome(home);
    expect(alive(other.pid!)).toBe(true);
  });

  it("refuses a folder that isn't an e2e home (it could be your real klaud data)", async () => {
    const home = tmp();
    writeFileSync(path.join(home, 'board.json'), '{"real":true}');
    await expect(freshHome(home)).rejects.toThrow(/isn't an e2e home/);
    expect(readFileSync(path.join(home, 'board.json'), 'utf8')).toBe('{"real":true}');
  });

  it('makes a home that is not there yet', async () => {
    const home = path.join(tmp(), 'new', 'home');
    expect(await freshHome(home)).toEqual([]);
    expect(existsSync(path.join(home, MARK))).toBe(true);
  });
});

describe('why the demo cannot start', () => {
  it('says the port is in use, and by which pid', async () => {
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(portProblem(port)).toMatch(new RegExp(`Port ${port} is in use by pid ${process.pid}`));
    } finally {
      server.close();
    }
  });

  it('says nothing for a free port', async () => {
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise((r) => server.close(r));
    expect(portProblem(port)).toBeUndefined();
  });
});

describe('teardown', () => {
  it('stops the demo daemon and clears its files, twice safely', async () => {
    const home = tmp();
    mkdirSync(home, { recursive: true });
    const daemon = fakeDaemon();
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ pid: daemon.pid }));
    await stopDaemon(home);
    await waitFor(() => !alive(daemon.pid!));
    expect(alive(daemon.pid!)).toBe(false);
    expect(existsSync(path.join(home, 'daemon.json'))).toBe(false);
    await expect(stopDaemon(home)).resolves.toBeUndefined();
  });
});
