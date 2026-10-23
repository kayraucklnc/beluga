import { useSyncExternalStore } from 'react';
import type { ChatFile } from '@beluga/net/mesh/views.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';

/**
 * Files waiting in a conversation's message box before you send them: each is taken into
 * Beluga's file store as soon as you add it (checksummed, cloned), so Send is instant. Kept per
 * conversation while the app runs, like drafts.
 */

export interface Pending {
  readonly key: string;
  readonly name: string;
  readonly state: 'adding' | 'ready' | 'failed';
  readonly file?: ChatFile;
  readonly error?: string;
  /** A local picture to show as a thumbnail (an object URL), when we have its bytes. */
  readonly thumb?: string;
}

/** Pasted bytes go to the daemon in parts of this size (any total size). */
export const PART_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

const lists = new Map<string, readonly Pending[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly Pending[] = [];
let seq = 0;

function set(id: string, next: readonly Pending[]): void {
  if (next.length) lists.set(id, next);
  else lists.delete(id);
  for (const l of [...listeners]) l();
}

const update = (id: string, key: string, patch: Partial<Pending>): void => set(id, (lists.get(id) ?? EMPTY).map((p) => (p.key === key ? { ...p, ...patch } : p)));

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^Error: /, '');

export function usePending(id: string): readonly Pending[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => lists.get(id) ?? EMPTY,
  );
}

function start(id: string, names: readonly string[], thumbs: ReadonlyArray<string | undefined> = []): string[] {
  const room = MAX_ATTACHMENTS - (lists.get(id) ?? EMPTY).length;
  const keys = names.slice(0, Math.max(0, room)).map(() => `a${++seq}`);
  set(id, [...(lists.get(id) ?? EMPTY), ...keys.map((key, i) => ({ key, name: names[i]!, state: 'adding' as const, ...(thumbs[i] ? { thumb: thumbs[i] } : {}) }))]);
  return keys;
}

/** Files from Finder (dropped or picked in the Open panel), by path. */
export async function addPaths(client: SocketClient, id: string, paths: readonly string[]): Promise<void> {
  const keys = start(id, paths.map((p) => p.split('/').pop() || p));
  await Promise.all(
    keys.map(async (key, i) => {
      try {
        const [file] = await client.api.network['files.add']([paths[i]!]);
        update(id, key, { state: 'ready', file: file!, name: file!.name });
        // A picture shows as a thumbnail, as a pasted one does.
        if (file!.mime?.startsWith('image/')) {
          const shown = await client.api.network['files.preview'](file!.sha).catch(() => undefined);
          if (shown && (lists.get(id) ?? EMPTY).some((p) => p.key === key)) {
            update(id, key, { thumb: URL.createObjectURL(new Blob([Uint8Array.from(atob(shown.b64), (c) => c.charCodeAt(0))], { type: shown.mime })) });
          }
        }
      } catch (err) {
        update(id, key, { state: 'failed', error: message(err) });
      }
    }),
  );
}

const base64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

/** Bytes without a path (pasted from the clipboard, or dropped from a browser). */
export async function addBlobs(client: SocketClient, id: string, files: readonly File[]): Promise<void> {
  const thumbs = files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined));
  const keys = start(
    id,
    files.map((f) => f.name || (f.type.startsWith('image/') ? `Pasted image.${f.type.split('/')[1] ?? 'png'}` : 'Pasted file')),
    thumbs,
  );
  await Promise.all(
    keys.map(async (key, i) => {
      const f = files[i]!;
      const name = lists.get(id)?.find((p) => p.key === key)?.name ?? 'file';
      try {
        // In parts, so any size goes (each part is one message to the daemon).
        const upload = `up-${key}-${Date.now().toString(36)}`;
        let file: ChatFile | undefined;
        for (let at = 0; at < Math.max(f.size, 1); at += PART_BYTES) {
          const last = at + PART_BYTES >= f.size;
          file = await client.api.network['files.addData'](name, await base64(f.slice(at, at + PART_BYTES)), { id: upload, last });
        }
        if (!file) throw new Error('It didn’t arrive whole');
        update(id, key, { state: 'ready', file, name: file.name });
      } catch (err) {
        update(id, key, { state: 'failed', error: message(err) });
      }
    }),
  );
}

export function removePending(id: string, key: string): void {
  const gone = (lists.get(id) ?? EMPTY).find((p) => p.key === key);
  if (gone?.thumb) URL.revokeObjectURL(gone.thumb);
  set(id, (lists.get(id) ?? EMPTY).filter((p) => p.key !== key));
}

/** Sent: the box is empty again (thumbnails are let go). */
export function takePending(id: string): ChatFile[] {
  const list = lists.get(id) ?? EMPTY;
  for (const p of list) if (p.thumb) URL.revokeObjectURL(p.thumb);
  set(id, []);
  return list.flatMap((p) => (p.state === 'ready' && p.file ? [p.file] : []));
}

/** Put files back after a send that failed (their thumbnails are gone; the files are still in the store). */
export function restorePending(id: string, files: readonly ChatFile[]): void {
  set(id, [...files.map((file) => ({ key: `a${++seq}`, name: file.name, state: 'ready' as const, file })), ...(lists.get(id) ?? EMPTY)]);
}
