import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const run = (cmd: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => execFile(cmd, [...args], { timeout: 60_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve())));

/**
 * Move a folder to the Trash, where you can put it back (never deleted outright). macOS's own
 * `trash` (15 and later), else Finder; on Linux, `gio trash`. Throws when it couldn't.
 */
export async function moveToTrash(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  if (process.platform === 'darwin') {
    if (existsSync('/usr/bin/trash')) return run('/usr/bin/trash', [dir]);
    const quoted = dir.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return run('osascript', ['-e', `tell application "Finder" to delete (POSIX file "${quoted}" as alias)`]);
  }
  if (process.platform === 'linux') return run('gio', ['trash', dir]);
  throw new Error('Moving to the Trash isn’t supported on this system');
}
