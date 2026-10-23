import { rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { daemonInfoPath, daemonLockPath, readDaemonInfo, releaseLock, runningDaemon, takeLock, writeDaemonInfo, clearDaemonInfo } from '../src/daemon/files.js';
import { type RunningDaemon, roomKeyOf, startDaemon } from '../src/daemon/main.js';
import { IPC_VERSION } from '../src/ipc/protocol.js';
import { SocketClient } from '../src/ipc/socket-client.js';
import { waitFor } from './helpers.js';

const running: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
  clearDaemonInfo();
  releaseLock();
});

const config = (...extra: string[]) => parseConfig(['--no-agent', '--tunnel', 'none', '--name', 'kay', ...extra]);
const start = async (opts: Partial<Parameters<typeof startDaemon>[1]> = {}): Promise<RunningDaemon> => {
  const d = await startDaemon(config(), { version: '1.0.0', keepAlive: false, lingerMs: 50, firstClientMs: 60_000, ...opts });
  running.push(d);
  return d;
};

describe('daemon files', () => {
  it('takes the start-up lock once, and takes over a dead holder', () => {
    expect(takeLock()).toBe(true);
    expect(takeLock()).toBe(false); // held (even by this process: one start at a time)
    releaseLock();
    writeFileSync(daemonLockPath(), '999999');
    expect(takeLock()).toBe(true);
    releaseLock();
    writeFileSync(daemonLockPath(), String(process.ppid));
    expect(takeLock()).toBe(false);
    rmSync(daemonLockPath());
  });

  it('only trusts daemon.json while its process lives', () => {
    const info = { pid: process.pid, port: 4000, token: 'x'.repeat(32), version: '1', ipc: IPC_VERSION, room: "kay's room", roomKey: 'host', startedAt: 1 };
    writeDaemonInfo(info);
    expect(runningDaemon()).toMatchObject({ port: 4000 });
    writeDaemonInfo({ ...info, pid: 999999 });
    expect(readDaemonInfo()?.pid).toBe(999999);
    expect(runningDaemon()).toBeUndefined();
    clearDaemonInfo(999999);
    expect(readDaemonInfo()).toBeUndefined();
    writeFileSync(daemonInfoPath(), 'not json');
    expect(readDaemonInfo()).toBeUndefined();
  });

  it('names rooms so screens attach only to theirs', () => {
    expect(roomKeyOf({ mode: 'host' })).toBe('host');
    expect(roomKeyOf({ mode: 'demo' })).toBe('demo');
    expect(roomKeyOf({ mode: 'join', invite: 'a' })).not.toBe(roomKeyOf({ mode: 'join', invite: 'b' }));
  });
});

describe('the daemon', () => {
  it('serves screens and leaves shortly after the last one closes', async () => {
    const d = await start();
    expect(runningDaemon()).toMatchObject({ port: d.port, roomKey: 'host', room: "kay's room" });
    const a = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
    const b = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
    await waitFor(() => a.clients === 2 && b.clients === 2);
    a.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(runningDaemon()).toBeDefined(); // b is still here
    b.close();
    await d.done;
    expect(runningDaemon()).toBeUndefined();
  });

  it('turns away wrong tokens and other protocol versions', async () => {
    const d = await start();
    await expect(SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: 'y'.repeat(64), kind: 'test', version: '1' })).rejects.toThrow();
  });

  it('stays up with no screens when kept alive, until asked to stop', async () => {
    const d = await start({ keepAlive: true });
    const a = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
    a.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(runningDaemon()).toBeDefined();
    const b = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
    const closed = new Promise<string>((r) => b.onClose(r));
    void b.api.daemon.stop().catch(() => undefined);
    expect(await closed).toBeTruthy();
    await d.done;
  });
});

describe('the daemon, under stress', () => {
  it('takes a frame as big as the largest image, and refuses big frames before hello', async () => {
    const d = await start();
    const a = await SocketClient.connect({ url: `ws://127.0.0.1:${d.port}`, token: d.token, kind: 'test', version: '1.0.0' });
    // 3.7 MB of image is about 5 MB of base64: the call is answered, the screen stays connected.
    const big = Buffer.alloc(Math.floor(3.7 * 1024 * 1024), 1).toString('base64');
    await a.api.attachments.add('png', big);
    expect(a.clients).toBe(1);
    const raw = new WebSocket(`ws://127.0.0.1:${d.port}`);
    await new Promise((r) => raw.addEventListener('open', r));
    const code = new Promise<number>((r) => raw.addEventListener('close', (e) => r(e.code)));
    raw.send('x'.repeat(100 * 1024));
    expect(await code).toBe(1009);
    a.close();
  });

  it('refuses a daemon.json with an impossible process id', () => {
    writeDaemonInfo({ pid: 0, port: 4000, token: 'x'.repeat(32), version: '1', ipc: IPC_VERSION, room: "kay's room", roomKey: 'host', startedAt: 1 });
    expect(readDaemonInfo()).toBeUndefined();
    rmSync(daemonInfoPath());
  });
});
