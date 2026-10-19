import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FsEntry } from '../protocol.js';

export { localDirKey } from './local-key.js';

/** Folders on this computer, for "/project add" completion (size 1 = git project). */
export function listLocalDirs(dir: string): FsEntry[] {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let git = false;
        try {
          git = statSync(path.join(abs, d.name, '.git')).isDirectory();
        } catch {
          git = false;
        }
        return { name: d.name, dir: true, size: git ? 1 : 0 };
      })
      .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Open a folder (or file, or URL) with the system's default app. */
export { systemOpen as openWithSystem } from './os-open.js';
