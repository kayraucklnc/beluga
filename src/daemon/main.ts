import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { copyNative } from '../core/clipboard.js';
import { currentClient } from '../core/client-context.js';
import { openWithSystem } from '../core/local.js';
import { IPC_VERSION } from '../ipc/protocol.js';
import { type Core, buildCore } from './core.js';
import { clearDaemonInfo, writeDaemonInfo } from './files.js';
import { DaemonServer } from './server.js';

/** How long the daemon waits after the last screen closes before leaving the room. */
export const LINGER_MS = 3000;
/** A daemon nobody attaches to (the screen that started it died) stops after this long. */
export const FIRST_CLIENT_MS = 30_000;

/** Which room a config is for, so a screen only attaches to a daemon in the same one. */
export function roomKeyOf(config: Pick<Config, 'mode' | 'invite'>): string {
  if (config.mode === 'demo') return 'demo';
  if (config.mode === 'join') return `join:${createHash('sha256').update(config.invite ?? '').digest('hex').slice(0, 16)}`;
  return 'host';
}

export interface DaemonOptions {
  readonly version: string;
  /** Keep running with no screens attached (the Mac app's sidecar). */
  readonly keepAlive: boolean;
  readonly port?: number;
  readonly allowedOrigins?: readonly string[];
  /** Where to say what's happening (the daemon's log). */
  readonly log?: (line: string) => void;
  /** Override LINGER_MS / FIRST_CLIENT_MS (tests). */
  readonly lingerMs?: number;
  readonly firstClientMs?: number;
}

export interface RunningDaemon {
  readonly core: Core;
  readonly server: DaemonServer;
  readonly port: number;
  readonly token: string;
  /** Leave the room and stop serving. Resolves once everything is closed. */
  stop(reason?: string): Promise<void>;
  /** Resolves when the daemon has stopped (by stop(), a signal, or the last screen leaving). */
  readonly done: Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `klaud daemon`: build the core once and serve it to every screen on this computer. Leaves the
 * room a few seconds after the last screen closes (so quitting the terminal UI still means
 * "leave"), unless it's kept alive for the Mac app.
 */
export async function startDaemon(config: Config, opts: DaemonOptions): Promise<RunningDaemon> {
  const log = opts.log ?? (() => undefined);
  const token = randomBytes(32).toString('hex');
  let server!: DaemonServer;
  let stopping: Promise<void> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const stop = (reason = 'klaud is shutting down'): Promise<void> => {
    stopping ??= (async () => {
      log(`stopping: ${reason}`);
      clearTimeout(linger);
      clearTimeout(firstClient);
      clearDaemonInfo();
      await server.close(reason).catch(() => undefined);
      await core.stop().catch((err: unknown) => log(`stop failed: ${errorText(err)}`));
      resolveDone();
    })();
    return stopping;
  };

  const core = await buildCore(config, {
    // The clipboard tool on this computer first; else the screen that asked (a terminal over SSH copies through its terminal).
    copy: async (text) => {
      if (await copyNative(text).catch(() => false)) return;
      await server.callCap('copyText', [text], currentClient());
    },
    desktopNotify: (n) => server.notify([n]),
    zoom: async (dir) => (await server.callCap('zoom', [dir], currentClient())) as { ok: boolean; message: string },
    open: (target) => openWithSystem(target),
    shutdown: () => void stop('Quit from a screen'),
  });
  server = new DaemonServer({ session: core.session, token, version: opts.version, terminals: core.terminals, ...(opts.port ? { port: opts.port } : {}), ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}) });
  const port = await server.listen();
  writeDaemonInfo({ pid: process.pid, port, token, version: opts.version, ipc: IPC_VERSION, room: core.room, roomKey: roomKeyOf(config), startedAt: Date.now(), keepAlive: opts.keepAlive });
  log(`listening on 127.0.0.1:${port} for ${core.room}${opts.keepAlive ? ' (kept alive)' : ''}`);

  let linger: NodeJS.Timeout | undefined;
  let firstClient: NodeJS.Timeout | undefined;
  let seen = false;
  if (!opts.keepAlive) {
    firstClient = setTimeout(() => {
      if (!seen) void stop('Nobody attached');
    }, opts.firstClientMs ?? FIRST_CLIENT_MS);
  }
  server.clients.onChange((count) => {
    log(`${count} screen${count === 1 ? '' : 's'} attached`);
    if (count > 0) {
      seen = true;
      clearTimeout(firstClient);
      clearTimeout(linger);
      linger = undefined;
      return;
    }
    if (opts.keepAlive) return;
    linger = setTimeout(() => {
      if (server.clients.size === 0) void stop('The last screen closed');
    }, opts.lingerMs ?? LINGER_MS);
  });

  core.start();
  return { core, server, port, token, stop, done };
}

/** Run the daemon as this process: signals stop it, problems are logged and shown, never fatal. */
export async function runDaemon(config: Config, opts: DaemonOptions): Promise<void> {
  const log = (line: string): void => void process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const daemon = await startDaemon(config, { ...opts, log });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void daemon.stop(`Got ${signal}`));
  process.on('unhandledRejection', (err) => {
    log(`unhandled: ${errorText(err)}`);
    daemon.core.session.toast(`Something went wrong: ${errorText(err)}`.slice(0, 200), 'error');
  });
  process.once('exit', () => clearDaemonInfo());
  await daemon.done;
  process.exit(0);
}
