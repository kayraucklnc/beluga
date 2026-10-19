import { execFile } from 'node:child_process';
export { formatBytes } from '../shared/format.js';

/** Bytes used by a folder (du), or undefined when it can't be measured in time. */
export function folderSize(dir: string, timeoutMs = 30_000): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('du', ['-sk', dir], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      // du exits non-zero on unreadable subfolders but still prints a total.
      const kb = Number(/^(\d+)/.exec(stdout ?? '')?.[1]);
      resolve(Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined);
    });
  });
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
