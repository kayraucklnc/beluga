import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Commands that start commands of their own (`npm run dev` → node → esbuild) are stopped whole.
 * On a Mac and on Linux the child leads its own process group (`detached`), and the group gets
 * the signal. Windows has no process groups, and `detached` there opens a console window, so the
 * child stays attached and `taskkill /T` ends it with everything it started.
 */

/** Spawn option: its own process group where there are groups. */
export const ownGroup = (platform: NodeJS.Platform = process.platform): boolean => platform !== 'win32';

/** Kill a child and everything it started, at once. Never throws (it may be gone already). */
export function killTree(child: Pick<ChildProcess, 'pid' | 'kill'>, platform: NodeJS.Platform = process.platform): void {
  try {
    if (!child.pid) child.kill('SIGKILL');
    else if (platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'));
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
