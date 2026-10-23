import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import net from 'node:net';
import { clearDaemonInfo, openDaemonLog, releaseLock, runningDaemon, takeLock } from '../daemon/files.js';
import type { ClientKind } from './client.js';
import type { DaemonInfo } from './protocol.js';
import { type Capabilities, SocketClient } from './socket-client.js';

export interface LaunchOptions {
  /** Arguments the daemon is started with (the same ones you gave Beluga). */
  readonly args: readonly string[];
  /** Which room this screen wants ('host' attaches to whatever runs; see roomKeyOf). */
  readonly roomKey: string;
  /** Attach to a daemon in any room (plain `beluga`). */
  readonly anyRoom: boolean;
  readonly version: string;
  readonly kind: ClientKind;
  readonly launchDir: string;
  readonly caps?: Capabilities;
  /** How long to wait for a daemon we started (default 10 s). */
  readonly timeoutMs?: number;
  /** Start the daemon (default: this same program, `beluga daemon …`, detached, logging to daemon.log). */
  readonly spawnDaemon?: (args: readonly string[]) => void;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Whether anything listens on this local port (a daemon that crashed left its file but not its server). */
export function listening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Start `beluga daemon` in the background: this program, same Node, same loader (tsx in development). */
export function spawnDaemonProcess(args: readonly string[]): void {
  const log = openDaemonLog();
  try {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? '', 'daemon', ...args], {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}

function connect(info: DaemonInfo, opts: LaunchOptions): Promise<SocketClient> {
  return SocketClient.connect({
    url: `ws://127.0.0.1:${info.port}`,
    token: info.token,
    kind: opts.kind,
    version: opts.version,
    launchDir: opts.launchDir,
    ...(opts.caps ? { caps: opts.caps } : {}),
  });
}

function checkRoom(info: DaemonInfo, opts: LaunchOptions): void {
  if (opts.anyRoom || info.roomKey === opts.roomKey) return;
  throw new Error(`Beluga is already running in ${info.room}. Quit it there first (or attach with plain \`Beluga\`).`);
}

/**
 * Attach to this computer's beluga daemon, starting it first when none runs. Two screens
 * opening at once start only one daemon (a lock file decides who starts it).
 */
export async function connectOrSpawn(opts: LaunchOptions): Promise<SocketClient> {
  const running = runningDaemon();
  if (running) {
    checkRoom(running, opts);
    // Its process id may belong to something else now (Beluga crashed, the id was reused).
    if (await listening(running.port)) return connect(running, opts);
    clearDaemonInfo(running.pid);
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const mine = takeLock();
  try {
    if (mine) (opts.spawnDaemon ?? spawnDaemonProcess)(opts.args);
    for (;;) {
      const info = runningDaemon();
      if (info) {
        checkRoom(info, opts);
        // It may still be getting its server up; retry briefly.
        try {
          return await connect(info, opts);
        } catch (err) {
          if (Date.now() > deadline) throw err;
        }
      }
      if (Date.now() > deadline) throw new Error('Beluga did not start in time. See ~/.beluga/logs/daemon.log');
      await wait(100);
    }
  } finally {
    if (mine) releaseLock();
  }
}
