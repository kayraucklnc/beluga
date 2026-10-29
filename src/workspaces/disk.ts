import { execFile } from 'node:child_process';
export { formatBytes } from '../shared/format.js';

/**
 * Bytes used by a folder (du), or undefined when it can't be measured in time. du runs at the
 * lowest CPU priority (BLG-407), so it never takes the computer from you or Claude; same number.
 */
export function folderSize(dir: string, timeoutMs = 30_000): Promise<number | undefined> {
  const run = (cmd: string, args: readonly string[]): Promise<{ missing: boolean; size: number | undefined }> =>
    new Promise((resolve) => {
      execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        // du exits non-zero on unreadable subfolders but still prints a total.
        const kb = Number(/^(\d+)/.exec(stdout ?? '')?.[1]);
        resolve({ missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT', size: Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined });
      });
    });
  if (process.platform === 'win32') return run('du', ['-sk', dir]).then((r) => r.size);
  // No nice here (a trimmed-down system): du as it is.
  return run('nice', ['-n', '19', 'du', '-sk', dir]).then((r) => (r.missing ? run('du', ['-sk', dir]).then((d) => d.size) : r.size));
}

/** Measure folders one at a time (so a dozen worktrees don't hammer the disk at once). */
export async function measureAll(dirs: ReadonlyArray<{ id: string; path: string }>, measure = folderSize): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of dirs) {
    const size = await measure(d.path);
    if (size !== undefined) out[d.id] = size;
  }
  return out;
}
