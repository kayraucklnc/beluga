import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BodyInput, type BodyOf, CHUNK_BYTES, MAX_DOWNLOAD_BYTES } from '../protocol.js';
import type { Location, Store } from './store.js';

export type Requester = <T>(to: string, body: BodyInput & { reqId: string }) => Promise<T>;

export const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'klaude');

/** Strip anything that could escape the download folder or confuse the OS. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return cleaned || 'download';
}

/** Pick `name`, `name (1)`, `name (2)`… so downloads never overwrite each other. */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/**
 * Pulls a file from a friend's share in end-to-end encrypted chunks and saves it
 * under ~/Downloads/klaude/<friend>/. Progress is mirrored into the store.
 */
export async function downloadFile(
  at: Location,
  from: string,
  request: Requester,
  store: Store,
  baseDir: string = DEFAULT_DOWNLOAD_DIR,
): Promise<string> {
  const id = randomUUID();
  const name = safeFileName(at.path);
  store.dispatch({ type: 'transfer', transfer: { id, name, from, received: 0, total: 0, status: 'active' } });
  const parts: Buffer[] = [];
  let offset = 0;
  let total = 0;
  try {
    do {
      const chunk = await request<BodyOf<'fs_chunk'>>(at.owner, { kind: 'fs_fetch', reqId: randomUUID(), share: at.share, path: at.path, offset });
      total = chunk.total ?? 0;
      if (total > MAX_DOWNLOAD_BYTES) throw new Error('File is too large');
      const data = Buffer.from(chunk.data ?? '', 'base64');
      if (chunk.offset !== offset || (data.length === 0 && offset < total)) throw new Error('Transfer got out of sync');
      parts.push(data);
      offset += data.length;
      store.dispatch({ type: 'transfer', transfer: { id, name, from, received: offset, total, status: 'active' } });
    } while (offset < total);
    const dir = path.join(baseDir, safeFileName(from));
    await fs.mkdir(dir, { recursive: true });
    const target = await uniquePath(dir, name);
    await fs.writeFile(target, Buffer.concat(parts));
    store.dispatch({ type: 'transfer', transfer: { id, name, from, received: total, total, status: 'done', savedTo: target } });
    return target;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    store.dispatch({ type: 'transfer', transfer: { id, name, from, received: offset, total, status: 'failed', error } });
    throw err;
  }
}

export const chunkSize = CHUNK_BYTES;
