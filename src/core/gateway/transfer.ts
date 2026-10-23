import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskFile } from './model.js';
import { CHUNK_BYTES, type FileChunk, type FileGet, type GatewayMsgInput, MAX_TRANSFER_FILE, MAX_TRANSFER_TOTAL, type ResultFile } from './protocol.js';

/**
 * Files too big to come inline with a result (screenshots, builds, logs) travel in pieces over
 * the same link the task used: a friend's mesh link (Noise, end to end) or the room. The owner
 * offers each file under a random id, only to the person the task came from, for a day; the
 * requester pulls it a piece at a time (file_get → file_chunk), checks the size it was told and
 * the SHA-256 at the end, and only then keeps it. Nothing is queued in the outbox: a piece that
 * doesn't come is asked for again, and a file that can't be had is reported as not received.
 */

/** How long an offered file can be fetched. */
export const OFFER_TTL_MS = 24 * 60 * 60_000;
const MAX_OFFERS = 64;
/** How long one piece may take, and how often it's asked for before the file is given up. */
export const CHUNK_TIMEOUT_MS = 20_000;
const CHUNK_TRIES = 6;

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

interface Offer {
  readonly taskId: string;
  readonly to: string;
  readonly path: string;
  readonly size: number;
  readonly expiresAt: number;
  served: number;
}

/** The owner's side: files offered with results, served a piece at a time to whoever may have them. */
export class FileOffers {
  private readonly offers = new Map<string, Offer>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Offer a file of a task's result to its requester; → the id and the checksum the result carries. */
  async offer(taskId: string, to: string, file: string): Promise<{ ref: string; sha256: string; size: number } | undefined> {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_TRANSFER_FILE) return undefined;
    this.prune();
    if (this.offers.size >= MAX_OFFERS) {
      const oldest = [...this.offers.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.offers.delete(oldest[0]);
    }
    const ref = randomBytes(12).toString('base64url');
    const sha256 = await sha256File(file);
    this.offers.set(ref, { taskId, to, path: file, size: stat.size, expiresAt: this.now() + OFFER_TTL_MS, served: 0 });
    return { ref, sha256, size: stat.size };
  }

  /** A piece someone asked for (or why they can't have it). */
  async chunk(from: string, msg: FileGet): Promise<GatewayMsgInput & { t: 'file_chunk' }> {
    const reply = (extra: { b64?: string; eof?: boolean; error?: string }): GatewayMsgInput & { t: 'file_chunk' } => ({ t: 'file_chunk', id: msg.id, ref: msg.ref, offset: msg.offset, ts: this.now(), ...extra });
    const offer = this.offers.get(msg.ref);
    // Unknown, someone else's, or for another task: the same answer, so nothing is learned.
    if (!offer || offer.to !== from || offer.taskId !== msg.id || offer.expiresAt <= this.now()) return reply({ error: 'That file is no longer available' });
    if (msg.offset > offer.size) return reply({ error: 'Past the end of the file' });
    // Asking for the same file over and over: it was had several times already.
    if (offer.served > offer.size * 4 + CHUNK_BYTES * 8) return reply({ error: 'That file was asked for too many times' });
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(offer.path, 'r');
      const buf = Buffer.alloc(Math.min(CHUNK_BYTES, offer.size - msg.offset));
      const { bytesRead } = buf.length ? await handle.read(buf, 0, buf.length, msg.offset) : { bytesRead: 0 };
      offer.served += bytesRead;
      return reply({ b64: buf.subarray(0, bytesRead).toString('base64'), eof: msg.offset + bytesRead >= offer.size });
    } catch {
      return reply({ error: 'That file could not be read' });
    } finally {
      await handle?.close();
    }
  }

  /** A task was cancelled or Beluga stops: what it offered goes. */
  drop(taskId?: string): void {
    for (const [ref, o] of this.offers) if (!taskId || o.taskId === taskId) this.offers.delete(ref);
  }

  private prune(): void {
    const now = this.now();
    for (const [ref, o] of this.offers) if (o.expiresAt <= now) this.offers.delete(ref);
  }
}

export interface Wanted {
  readonly name: string;
  readonly ref: string;
  readonly size: number;
  readonly sha256?: string;
}

export interface Fetched {
  readonly name: string;
  readonly size: number;
  readonly path?: string;
  readonly error?: string;
}

type Waiter = { resolve: (msg: FileChunk) => void; timer: NodeJS.Timeout };

export interface FetcherDeps {
  readonly send: (to: string, msg: GatewayMsgInput) => boolean;
  /** Where a file of this task with this name goes (a new path, nothing there yet). */
  readonly target: (taskId: string, name: string) => Promise<string>;
  readonly now?: () => number;
  readonly chunkTimeoutMs?: number;
}

/** The requester's side: pull the files a result offered, a piece at a time, and check them. */
export class FileFetcher {
  private readonly waiting = new Map<string, Waiter>();
  private stopped = false;

  constructor(private readonly deps: FetcherDeps) {}

  stop(): void {
    this.stopped = true;
    for (const w of this.waiting.values()) clearTimeout(w.timer);
    this.waiting.clear();
  }

  /** A piece arrived (only from the person the file is fetched from: the key says who). */
  onChunk(from: string, msg: FileChunk): void {
    const key = `${from}:${msg.id}:${msg.ref}:${msg.offset}`;
    const w = this.waiting.get(key);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(key);
    w.resolve(msg);
  }

  /** Fetch these files of a task from `from`, one after the other; `progress` hears the bytes so far. */
  async fetchAll(from: string, taskId: string, files: readonly Wanted[], progress: (received: number) => void): Promise<Fetched[]> {
    const out: Fetched[] = [];
    let before = 0;
    for (const f of files) {
      out.push(await this.fetchOne(from, taskId, f, (n) => progress(before + n)));
      before += f.size;
      progress(before);
    }
    return out;
  }

  private async fetchOne(from: string, taskId: string, want: Wanted, progress: (n: number) => void): Promise<Fetched> {
    if (want.size > MAX_TRANSFER_FILE) return { name: want.name, size: want.size, error: 'too big to send' };
    let target: string;
    try {
      target = await this.deps.target(taskId, want.name);
    } catch {
      return { name: want.name, size: want.size, error: 'could not be saved here' };
    }
    const part = `${target}.part`;
    const hash = createHash('sha256');
    let handle: fs.FileHandle | undefined;
    let offset = 0;
    try {
      handle = await fs.open(part, 'w', 0o600);
      for (;;) {
        const piece = await this.ask(from, taskId, want.ref, offset);
        if (piece.error) throw new Error(piece.error);
        const bytes = Buffer.from(piece.b64, 'base64');
        if (bytes.length > CHUNK_BYTES || offset + bytes.length > want.size) throw new Error('more data came than the file has');
        if (!bytes.length && !piece.eof) throw new Error('an empty piece came');
        await handle.write(bytes, 0, bytes.length, offset);
        hash.update(bytes);
        offset += bytes.length;
        progress(offset);
        if (piece.eof || offset >= want.size) break;
      }
      await handle.close();
      handle = undefined;
      if (offset !== want.size) throw new Error('it came incomplete');
      if (want.sha256 && hash.digest('hex') !== want.sha256) throw new Error('it came damaged (checksum mismatch)');
      await fs.rename(part, target);
      return { name: want.name, size: offset, path: target };
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await fs.rm(part, { force: true }).catch(() => undefined);
      return { name: want.name, size: want.size, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Ask for one piece, again a few times if it doesn't come. */
  private async ask(from: string, taskId: string, ref: string, offset: number): Promise<FileChunk> {
    for (let attempt = 0; attempt < CHUNK_TRIES; attempt++) {
      if (this.stopped) throw new Error('Beluga stopped');
      const got = await new Promise<FileChunk | undefined>((resolve) => {
        const key = `${from}:${taskId}:${ref}:${offset}`;
        const timer = setTimeout(() => {
          this.waiting.delete(key);
          resolve(undefined);
        }, this.deps.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS);
        timer.unref?.();
        this.waiting.set(key, { resolve, timer });
        this.deps.send(from, { t: 'file_get', id: taskId, ref, offset, ts: (this.deps.now ?? Date.now)() });
      });
      if (got) return got;
    }
    throw new Error(`no answer from them after ${CHUNK_TRIES} tries`);
  }
}

/** The files of a result to fetch in pieces (within the limits: per file, per task). */
export function wantedFiles(files: readonly ResultFile[]): Wanted[] {
  let budget = MAX_TRANSFER_TOTAL;
  return files.flatMap((f) => {
    if (!f.ref || f.b64 || f.size > MAX_TRANSFER_FILE || f.size > budget) return [];
    budget -= f.size;
    return [{ name: f.name, ref: f.ref, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}) }];
  });
}

/** The result's files in its order: those that came inline (saved), those fetched, those that didn't come. */
export function mergeFiles(files: readonly ResultFile[], inline: readonly TaskFile[], wanted: readonly Wanted[], fetched: readonly Fetched[]): TaskFile[] {
  const byRef = new Map(wanted.map((w, i) => [w.ref, fetched[i]]));
  const inlineFiles = files.filter((f) => !f.ref || f.b64);
  return files.map((f) => {
    const image = f.image ? { image: true } : {};
    const got = f.ref && !f.b64 ? byRef.get(f.ref) : undefined;
    if (got) return { name: got.path ? path.basename(got.path) : got.name, size: got.size, ...(got.path ? { path: got.path } : {}), ...image };
    return inline[inlineFiles.indexOf(f)] ?? { name: f.name, size: f.size, ...image };
  });
}
