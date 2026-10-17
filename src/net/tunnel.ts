import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type TunnelKind = 'auto' | 'ngrok' | 'cloudflared' | 'none';

export interface Tunnel {
  readonly kind: Exclude<TunnelKind, 'auto' | 'none'>;
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

/** Every tunnel process we spawned, so none outlive klaud (they expose your hub publicly). */
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
  const publicUrl = await waitForUrl(child, CLOUDFLARE_URL, 'cloudflared', opts.onDied);
  return { kind: 'cloudflared', publicUrl, close: () => child.kill() };
}

/** Use the cloudflared binary bundled via npm, downloading it on first use if missing. */
async function managedCloudflared(onProgress: (msg: string) => void): Promise<string> {
  const pkg = await import('cloudflared');
  if (existsSync(pkg.bin)) return pkg.bin;
  onProgress('Downloading Cloudflare tunnel helper (one-time)…');
  mkdirSync(path.dirname(pkg.bin), { recursive: true });
  return pkg.install(pkg.bin);
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
 * Expose the local hub to the internet. `auto` prefers a free Cloudflare quick
 * tunnel (no account; downloaded automatically) and falls back to ngrok.
 */
export async function openTunnel(kind: TunnelKind, port: number, opts: TunnelOptions = {}): Promise<Tunnel | undefined> {
  if (kind === 'none') return undefined;
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
