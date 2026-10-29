import { spawn } from 'node:child_process';

/** Open a file, folder or URL with the system's default app. Never throws (e.g. no xdg-open). */
export function systemOpen(target: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [target], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

/** Show a file in Finder, selected (elsewhere: its folder). Never throws. */
export function revealInFinder(file: string): void {
  if (process.platform !== 'darwin') return systemOpen(file.replace(/\/[^/]*$/, ''));
  spawn('open', ['-R', file], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}
