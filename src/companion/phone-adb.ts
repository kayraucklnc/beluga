import { homedir } from 'node:os';
import path from 'node:path';
import type { SystemPort } from '../core/gateway/device.js';

/**
 * Finding and running Android's `adb` on this Mac, for driving a paired phone (BLG-150). Nothing
 * here knows about the link or the agent: it only locates the tool and runs it against one serial.
 * Every call goes through a SystemPort, so tests pass a fake adb and never touch a real phone.
 */

/** Where adb usually is, in the order we try (the SDK's own, then Homebrew). PATH is tried too. */
export function adbCandidates(home = homedir()): string[] {
  return [
    path.join(home, 'Library/Android/sdk/platform-tools/adb'),
    path.join(home, 'Android/Sdk/platform-tools/adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools/adb') : '',
  ].filter(Boolean);
}

/** The first adb that answers `adb version`, with its version line; undefined if none is installed. */
export async function findAdb(sys: SystemPort, home?: string): Promise<{ path: string; version: string } | undefined> {
  const tryOne = async (p: string): Promise<{ path: string; version: string } | undefined> => {
    const res = await sys.exec(p, ['version'], 8_000).catch(() => undefined);
    if (!res || res.code !== 0) return undefined;
    const version = /Android Debug Bridge version ([\d.]+)/.exec(res.stdout)?.[1] ?? res.stdout.split('\n')[0]?.trim() ?? 'unknown';
    return { path: p, version };
  };
  // `which` first, so a user's own install on PATH wins; then the usual spots.
  const which = await sys.exec('/usr/bin/which', ['adb'], 5_000).catch(() => undefined);
  const onPath = which?.code === 0 ? which.stdout.trim().split('\n')[0]?.trim() : undefined;
  for (const p of [...(onPath ? [onPath] : []), ...adbCandidates(home)]) {
    const found = await tryOne(p);
    if (found) return found;
  }
  return undefined;
}

export interface AdbResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** adb bound to one serial: every command carries `-s <serial>`. */
export class Adb {
  constructor(
    private readonly sys: SystemPort,
    readonly adbPath: string,
    readonly serial: string,
  ) {}

  run(args: readonly string[], timeoutMs = 15_000): Promise<AdbResult> {
    return this.sys.exec(this.adbPath, ['-s', this.serial, ...args], timeoutMs);
  }

  /** A command in the phone's shell. */
  shell(command: string, timeoutMs = 20_000): Promise<AdbResult> {
    return this.run(['shell', command], timeoutMs);
  }

  /** Raw bytes from `adb exec-out` (a screenshot, a file): stdout as a Buffer, no shell mangling. */
  async execOutBytes(args: readonly string[], timeoutMs = 20_000): Promise<Buffer> {
    const res = await this.sys.execBytes?.(this.adbPath, ['-s', this.serial, 'exec-out', ...args], timeoutMs);
    if (res) {
      if (res.code !== 0) throw new Error(res.stderr.toString('utf8').trim().slice(0, 200) || `adb exited ${res.code}`);
      return res.stdout;
    }
    // A SystemPort without execBytes (older tests): fall back to base64 over the text channel.
    const text = await this.run(['exec-out', ...args, '|', 'base64'], timeoutMs);
    if (text.code !== 0) throw new Error(text.stderr.trim().slice(0, 200) || `adb exited ${text.code}`);
    return Buffer.from(text.stdout.replace(/\s+/g, ''), 'base64');
  }

  /** `adb exec-out` streamed as it comes (a screen video), until it ends or stop(); undefined without streaming. */
  stream(args: readonly string[], onData: (chunk: Buffer) => void, onEnd: (code: number | null, stderr: string) => void): { stop(): void } | undefined {
    return this.sys.stream?.(this.adbPath, ['-s', this.serial, 'exec-out', ...args], onData, onEnd);
  }

  /** The screen's size in the pixels taps use (`wm size`: the override when there is one, as Samsung's FHD+ is). */
  async screenSize(): Promise<{ w: number; h: number } | undefined> {
    const res = await this.shell('wm size', 6_000).catch(() => undefined);
    return res ? parseWmSize(res.stdout) : undefined;
  }
}

/** `wm size` → the size taps use: "Override size" when set, else "Physical size". */
export function parseWmSize(stdout: string): { w: number; h: number } | undefined {
  const m = /Override size: (\d+)x(\d+)/.exec(stdout) ?? /Physical size: (\d+)x(\d+)/.exec(stdout);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

/** `adb devices -l` → the serials attached now, with how each is connected. */
export function parseDevices(stdout: string): Array<{ serial: string; state: string; usb: boolean }> {
  return stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      if (!serial || !state) return [];
      const info = rest.join(' ');
      // A Wi-Fi/tunnel device is `ip:port`, or adb's own mDNS name (`adb-<serial>-…._adb-tls-connect._tcp`);
      // a USB one has a `usb:` field and no colon in the serial.
      const wireless = serial.includes(':') || serial.includes('._adb-tls-connect.');
      const usb = /\busb:/.test(info) || (!wireless && !/\bemulator\b/.test(serial));
      return [{ serial, state, usb }];
    });
}
