import { useEffect, useSyncExternalStore } from 'react';
import type { ArchivePreview } from '@klaud/workspaces/archive.js';
import type { ApiProxy as KlaudApi } from '@klaud/ipc/client.js';

/**
 * How much of each worktree is dependencies, builds and caches (what archiving or Free Up Space
 * clears), looked at one worktree at a time in the background and kept for this window. A
 * worktree that was cleaned or changed size is looked at again.
 */

interface Known {
  readonly plan: ArchivePreview;
  /** Its size on disk when it was looked at (another size: look again). */
  readonly size: number | undefined;
}

const known = new Map<string, Known>();
const listeners = new Set<() => void>();
let version = 0;
let running = false;

const changed = (): void => {
  version++;
  for (const l of listeners) l();
};

/** Look again at these (they were just cleaned or archived). */
export function forgetRebuildable(ids: readonly string[]): void {
  for (const id of ids) known.delete(id);
  changed();
}

async function lookAt(api: KlaudApi, queue: ReadonlyArray<{ id: string; size: number | undefined }>): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const { id, size } of queue) {
      if (known.get(id)?.size === size && known.has(id)) continue;
      const plan = await api.workspaces.archivePlan(id).catch(() => undefined);
      if (plan) known.set(id, { plan, size });
      changed();
    }
  } finally {
    running = false;
  }
}

/** Plans for these worktrees (as they come in): by id. */
export function useRebuildable(api: KlaudApi, rows: ReadonlyArray<{ id: string; size: number | undefined }>): ReadonlyMap<string, ArchivePreview> {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  const key = rows.map((r) => `${r.id}:${r.size ?? ''}`).join(',');
  useEffect(() => {
    void lookAt(
      api,
      rows.filter((r) => known.get(r.id)?.size !== r.size || !known.has(r.id)),
    ).then(() => {
      // Some came in while it was busy with others: once more for those.
      if (rows.some((r) => !known.has(r.id))) void lookAt(api, rows);
    });
  }, [key]);
  return new Map(rows.flatMap((r) => (known.has(r.id) ? [[r.id, known.get(r.id)!.plan] as const] : [])));
}
