import { spawn, type ChildProcess } from 'node:child_process';

export type TunnelKind = 'auto' | 'ngrok' | 'cloudflared' | 'none';

export interface Tunnel {
  readonly kind: Exclude<TunnelKind, 'auto' | 'none'>;
  readonly publicUrl: string;
  close(): void;
}

const TIMEOUT_MS = 30_000;

function waitForUrl(child: ChildProcess, pattern: RegExp, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${name} did not report a public URL within ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    const scan = (chunk: Buffer): void => {
      const match = pattern.exec(chunk.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name} could not start: ${err.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited (code ${code}). Is it installed and authenticated?`));
    });
  });
}

async function startNgrok(port: number): Promise<Tunnel> {
  const child = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const publicUrl = await waitForUrl(child, /"url":"(https:\/\/[^"]+)"/, 'ngrok');
  return { kind: 'ngrok', publicUrl, close: () => child.kill() };
}

async function startCloudflared(port: number): Promise<Tunnel> {
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const publicUrl = await waitForUrl(child, /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/, 'cloudflared');
  return { kind: 'cloudflared', publicUrl, close: () => child.kill() };
}

/**
 * Expose the local hub to the internet. `auto` tries ngrok, then cloudflared
 * (a free "quick tunnel" that needs no account).
 */
export async function openTunnel(kind: TunnelKind, port: number): Promise<Tunnel | undefined> {
  if (kind === 'none') return undefined;
  if (kind === 'ngrok') return startNgrok(port);
  if (kind === 'cloudflared') return startCloudflared(port);
  const errors: string[] = [];
  for (const start of [startNgrok, startCloudflared]) {
    try {
      return await start(port);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`No tunnel available. Install ngrok or cloudflared, or use --lan.\n  ${errors.join('\n  ')}`);
}
