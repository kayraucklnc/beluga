import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from '../core/home.js';

/**
 * How friends reach the host. `p2p`: direct only (hyperdht). `auto`: direct, plus a
 * Cloudflare (then ngrok) relay as the fallback. `cloudflared` / `ngrok`: relay only.
 * `none`: your local network only.
 */
export type TunnelKind = 'auto' | 'p2p' | 'ngrok' | 'cloudflared' | 'none';

/** Whether this setting offers direct peer-to-peer connections. */
export const offersDirect = (kind: TunnelKind): boolean => kind === 'auto' || kind === 'p2p';

export interface Tunnel {
  readonly kind: Exclude<TunnelKind, 'auto' | 'p2p' | 'none'>;
  readonly publicUrl: string;
  close(): void;
}

export interface TunnelOptions {
  readonly onProgress?: (msg: string) => void;
  /** Called if the tunnel process dies after it was up. */
  readonly onDied?: (reason: string) => void;
}

const TIMEOUT_MS = 45_000;
/** Quick-tunnel hostnames; excludes api.trycloudflare.com, which appears in cloudflared's error output. */
export const CLOUDFLARE_URL = /(https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com)/;
export const NGROK_URL = /"url":"(https:\/\/[^"]+)"/;

/** Every tunnel process we spawned, so none outlive Beluga (they expose your hub publicly). */
const children = new Set<ChildProcess>();

export function closeAllTunnels(): void {
  for (const child of children) child.kill();
  children.clear();
}
process.once('exit', closeAllTunnels);

function waitForUrl(child: ChildProcess, pattern: RegExp, name: string, onDied?: (reason: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffered = '';
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`${name} did not report a public URL within ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    function fail(err: Error): void {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
    const scan = (chunk: Buffer): void => {
      if (settled) return;
      // Keep the tail so a URL split across two chunks is still found.
      buffered = (buffered + chunk.toString()).slice(-4096);
      const match = pattern.exec(buffered);
      if (match?.[1]) {
        clearTimeout(timer);
        settled = true;
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.once('error', (err) => fail(new Error(`${name} could not start: ${err.message}`)));
    child.once('exit', (code) => {
      children.delete(child);
      if (settled) onDied?.(`${name} stopped (code ${code})`);
      else fail(new Error(`${name} exited (code ${code})`));
    });
  });
}

function launch(cmd: string, args: readonly string[]): ChildProcess {
  const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  return child;
}

async function startNgrok(port: number, opts: TunnelOptions): Promise<Tunnel> {
  const child = launch('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json']);
  const publicUrl = await waitForUrl(child, NGROK_URL, 'ngrok', opts.onDied);
  return { kind: 'ngrok', publicUrl, close: () => child.kill() };
}

async function startCloudflaredWith(bin: string, port: number, opts: TunnelOptions): Promise<Tunnel> {
  const child = launch(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`]);
  let why: string | undefined;
  const publicUrl = await waitForUrl(child, CLOUDFLARE_URL, 'cloudflared', opts.onDied && ((reason) => opts.onDied?.(why ?? reason)));
  // A quick tunnel's name can vanish while cloudflared keeps running (Cloudflare drops it after
  // the Mac sleeps): kill it then, so onDied fires and whoever opened it opens a fresh one.
  const watch = watchTunnel(publicUrl, () => {
    why = 'cloudflared’s public name stopped answering';
    child.kill();
  });
  child.once('exit', () => watch.stop());
  return {
    kind: 'cloudflared',
    publicUrl,
    close: () => {
      watch.stop();
      child.kill();
    },
  };
}

/** Whether a URL answers at all: a page, a redirect, or a WebSocket server's 426. Cloudflare's 530 (no tunnel) doesn't count. */
async function answers(url: string, timeoutMs = 8_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return res.status < 500 || res.status === 426;
  } catch {
    return false;
  }
}

/** What a tunnel's own name is checked against: when this doesn't answer either, the Mac is offline, not the tunnel dead. */
const CONTROL_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

export interface WatchOptions {
  /** How often the name is checked (and the clock watched for a sleep). */
  readonly intervalMs?: number;
  /** Misses in a row, while the internet answers, before the tunnel counts as dead. */
  readonly misses?: number;
  /** How long a fresh name may take to resolve before misses count. */
  readonly graceMs?: number;
  readonly answers?: (url: string) => Promise<boolean>;
}

/**
 * Keep checking a tunnel's public URL; `onDead` once it stops answering while the internet still
 * does. Checked every minute, and at once after the clock jumps (the Mac woke up from sleep).
 */
export function watchTunnel(publicUrl: string, onDead: () => void, opts: WatchOptions = {}): { stop(): void } {
  const interval = opts.intervalMs ?? 60_000;
  const needed = opts.misses ?? 2;
  const graceMs = opts.graceMs ?? 3 * 60_000;
  const check = opts.answers ?? answers;
  const started = Date.now();
  let seen = false;
  let missed = 0;
  let busy = false;
  let stopped = false;
  let last = Date.now();
  const tick = async (): Promise<void> => {
    if (busy || stopped) return;
    busy = true;
    try {
      if (await check(publicUrl)) {
        seen = true;
        missed = 0;
        return;
      }
      if (!seen && Date.now() - started < graceMs) return;
      // Offline isn't dead: a new tunnel couldn't do better.
      if (!(await check(CONTROL_URL))) return;
      if (++missed >= needed && !stopped) {
        stopped = true;
        clearInterval(timer);
        onDead();
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    const now = Date.now();
    const slept = now - last > interval * 2;
    last = now;
    void tick().then(() => {
      // Just woke: look again soon instead of a minute later, cloudflared needs a moment to reconnect.
      if (slept && missed > 0 && !stopped) setTimeout(() => void tick(), Math.min(interval, 15_000)).unref?.();
    });
  }, interval);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * The cloudflared binary npm installed, or else one downloaded on first use. The Mac app doesn't
 * bundle it (BLG-383) and can't write inside itself, so that one goes to ~/.beluga/bin.
 */
async function managedCloudflared(onProgress: (msg: string) => void): Promise<string> {
  const pkg = await import('cloudflared');
  if (existsSync(pkg.bin)) return pkg.bin;
  const bin = path.join(belugaHome(), 'bin', 'cloudflared');
  if (existsSync(bin)) return bin;
  onProgress('Downloading Cloudflare tunnel helper (one-time)…');
  mkdirSync(path.dirname(bin), { recursive: true });
  return pkg.install(bin);
}

async function startCloudflared(port: number, opts: TunnelOptions): Promise<Tunnel> {
  try {
    return await startCloudflaredWith('cloudflared', port, opts);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('could not start')) throw err;
  }
  return startCloudflaredWith(await managedCloudflared(opts.onProgress ?? (() => undefined)), port, opts);
}

/**
 * Fresh quick-tunnel hostnames take a while to resolve. Poll until the hub answers
 * (a websocket server replies 426 to plain HTTP) so we never hand out a dead link.
 */
export async function waitUntilReachable(publicUrl: string, timeoutMs = 120_000, intervalMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(publicUrl, { signal: AbortSignal.timeout(5_000) });
      if (res.status < 500 || res.status === 426) return true;
    } catch {
      // DNS not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Expose the local hub to the internet through a relay. `auto` prefers a free Cloudflare
 * quick tunnel (no account; downloaded automatically) and falls back to ngrok. `p2p` and
 * `none` need no relay. (Direct connections are the hub's job: `hub.listenP2P()`.)
 */
export async function openTunnel(kind: TunnelKind, port: number, opts: TunnelOptions = {}): Promise<Tunnel | undefined> {
  if (kind === 'none' || kind === 'p2p') return undefined;
  if (kind === 'ngrok') return startNgrok(port, opts);
  if (kind === 'cloudflared') return startCloudflared(port, opts);
  const errors: string[] = [];
  for (const start of [() => startCloudflared(port, opts), () => startNgrok(port, opts)]) {
    try {
      return await start();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`Could not open a tunnel: ${errors.join('; ')}`);
}
