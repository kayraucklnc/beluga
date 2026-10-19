import { spawn } from 'node:child_process';

/** Open a file, folder or URL with the system's default app. Never throws (e.g. no xdg-open). */
export function systemOpen(target: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [target], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
