import type { FsEntry } from '../../protocol.js';
import { SHOWN_SCRATCH_DIRS } from '../../shared/scratch-dir.js';
import { shareNameOf } from '../../shared/share-names.js';
import type { Location } from '../store.js';

/**
 * A friend's worktree's scratch folder, as your Scratch tab shows your own (BLG-259): what their
 * Claude saved while it worked, newest first, listed over the link (`fs_list` with times) and read
 * file by file when you open one, so nothing is downloaded ahead.
 */

const MAX_FILES = 300;
const MAX_DEPTH = 4;

export interface RemoteScratch {
  readonly root: string;
  readonly dir: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly size: number; readonly mtime: number }>;
}

export async function remoteScratch(owner: string, wsId: string, list: (at: Location, opts: { times: boolean }) => Promise<readonly FsEntry[]>): Promise<RemoteScratch> {
  const share = shareNameOf(wsId);
  const files: Array<{ path: string; size: number; mtime: number }> = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await list({ owner, share, path: rel }, { times: true }).catch(() => [] as readonly FsEntry[]);
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.dir && depth < MAX_DEPTH) await walk(child, depth + 1);
      else if (!e.dir) files.push({ path: child, size: e.size, mtime: e.mtime ?? 0 });
    }
  };
  for (const rel of SHOWN_SCRATCH_DIRS) await walk(rel, 1);
  return { root: '', dir: '', files: files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, MAX_FILES) };
}
