/// <reference path="./modules.d.ts" />
import b4a from 'b4a';
import { COMPANION_PIECE } from './protocol.js';

export { mediaPath } from './media.js';

/**
 * Videos on the phone, streamed (BLG-100, BLG-103). The phone's video player (expo-video: ExoPlayer,
 * AVPlayer) only plays a URL, so the link worklet runs a tiny HTTP server on the phone's loopback
 * (127.0.0.1, a random port and a random token in every URL) and answers the player's range
 * requests with pieces of the file fetched over the encrypted link (`get {ref, 'full', off}`, the
 * same pieces as pictures: COMPANION_PIECE bytes from `off`). Only what the player reads is
 * fetched, a little ahead of it and no faster than it takes it (the socket's backpressure); what
 * came is kept in a small cache, so seeking back or playing again costs nothing.
 *
 * The Mac still decides, piece by piece, that it's an output and no secret (src/companion/files.ts):
 * this server only knows refs, never paths. Runtime-agnostic like client.ts (Bare on the phone,
 * Node in the tests): no Node builtins, the socket and server are passed in.
 */

export interface MediaPiece {
  readonly bytes: Uint8Array;
  /** The whole file's size. */
  readonly size: number;
  readonly mime: string;
}

/** One piece of an output from `off` (at most COMPANION_PIECE bytes). */
export type FetchPiece = (ref: string, off: number) => Promise<MediaPiece>;

/** What fetched pieces are kept (the least recently used go first). */
export const MEDIA_CACHE_BYTES = 48 * 1024 * 1024;
/** Pieces fetched ahead of the one being written. */
export const MEDIA_READ_AHEAD = 2;
/** A request's head may be no longer than this. */
const MAX_HEAD = 8 * 1024;
/** A ref as the Mac hands them out (`out:` and base64url). */
const REF = /^out:[A-Za-z0-9_-]{1,64}$/;

/** The pieces of outputs fetched so far, shared by every request (one fetch per piece, however many ask). */
export class PieceCache {
  private readonly pieces = new Map<string, Promise<MediaPiece>>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;

  constructor(
    private readonly fetch: FetchPiece,
    private readonly maxBytes = MEDIA_CACHE_BYTES,
    readonly piece = COMPANION_PIECE,
  ) {}

  /** Piece number `index` of `ref` (bytes from index × piece). */
  get(ref: string, index: number): Promise<MediaPiece> {
    const key = `${ref}#${index}`;
    const hit = this.pieces.get(key);
    if (hit) {
      // Used again: it's the newest now.
      this.pieces.delete(key);
      this.pieces.set(key, hit);
      return hit;
    }
    const p = this.fetch(ref, index * this.piece);
    this.pieces.set(key, p);
    p.then(
      (got) => {
        if (this.pieces.get(key) !== p) return;
        this.sizes.set(key, got.bytes.length);
        this.bytes += got.bytes.length;
        this.trim();
      },
      // A failed piece is fetched again next time.
      () => {
        if (this.pieces.get(key) === p) this.pieces.delete(key);
      },
    );
    return p;
  }

  /** Bytes kept now. */
  get size(): number {
    return this.bytes;
  }

  has(ref: string, index: number): boolean {
    return this.sizes.has(`${ref}#${index}`);
  }

  clear(): void {
    this.pieces.clear();
    this.sizes.clear();
    this.bytes = 0;
  }

  private trim(): void {
    for (const key of this.pieces.keys()) {
      if (this.bytes <= this.maxBytes) return;
      const n = this.sizes.get(key);
      // Still coming: not counted yet, and wanted.
      if (n === undefined) continue;
      this.pieces.delete(key);
      this.sizes.delete(key);
      this.bytes -= n;
    }
  }
}

export interface ByteRange {
  readonly start: number;
  /** Inclusive. */
  readonly end: number;
}

/**
 * A `Range` header against a file of `size` bytes: the one range it asks for (clamped to the file),
 * undefined for no (or an unusable) header, which means the whole file, or 'unsatisfiable' (416).
 * Only single byte ranges; a list takes its first, as players never ask for more.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(header);
  if (!m) return undefined;
  const [, a = '', b = ''] = m;
  if (!a && !b) return undefined;
  if (!a) {
    // The last `b` bytes.
    const n = Number(b);
    if (!n || !size) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return 'unsatisfiable';
  const end = b ? Math.min(Number(b), size - 1) : size - 1;
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

export interface MediaRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** An HTTP/1.1 request head (up to the blank line), or undefined when it isn't one. */
export function parseHead(head: string): MediaRequest | undefined {
  const lines = head.split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
  if (!m) return undefined;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { method: m[1]!, path: m[2]!, headers };
}

/** The ref a media URL names (`/<token>/<ref>/<name>`), when the token is this server's. */
export function refOfPath(urlPath: string, token: string): string | undefined {
  const [, t, ref] = urlPath.split('?')[0]!.split('/');
  if (!t || !ref || !sameToken(t, token)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    return undefined;
  }
  return REF.test(decoded) ? decoded : undefined;
}

/** Compared in full whatever differs first, so the token can't be guessed a character at a time. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The parts of a TCP socket the server uses (bare-tcp's and Node's both have them). */
export interface MediaSocket {
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  on(event: 'data', fn: (data: Uint8Array) => void): unknown;
  on(event: 'drain' | 'close' | 'end', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  removeListener(event: 'drain' | 'close', fn: () => void): unknown;
}

const STATUS: Readonly<Record<number, string>> = { 200: 'OK', 206: 'Partial Content', 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 416: 'Range Not Satisfiable', 502: 'Bad Gateway' };

function head(status: number, headers: Record<string, string | number>): Uint8Array {
  const lines = [`HTTP/1.1 ${status} ${STATUS[status] ?? 'Error'}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), 'Connection: close', '', ''];
  return b4a.from(lines.join('\r\n'), 'utf8');
}

function fail(socket: MediaSocket, status: number, text: string): void {
  const body = b4a.from(text, 'utf8');
  socket.write(head(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length }));
  socket.write(body);
  socket.end();
}

export interface ServeOptions {
  readonly token: string;
  readonly cache: PieceCache;
}

/**
 * Answer one connection: one request (`Connection: close`), GET or HEAD of a media URL, the whole
 * file or one byte range, written piece by piece as the player takes them. Stops fetching the
 * moment the player hangs up (a seek, a pause it doesn't need more for, the screen closing).
 */
export function serveMediaSocket(socket: MediaSocket, opts: ServeOptions): void {
  let buffered = '';
  let started = false;
  let closed = false;
  socket.on('error', () => undefined);
  socket.on('close', () => {
    closed = true;
  });
  socket.on('data', (data) => {
    if (started) return;
    buffered += b4a.toString(data, 'latin1');
    const end = buffered.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buffered.length > MAX_HEAD) {
        started = true;
        fail(socket, 400, 'Bad request');
      }
      return;
    }
    started = true;
    const req = parseHead(buffered.slice(0, end));
    void answer(socket, req, opts, () => closed).catch(() => socket.destroy());
  });
}

async function answer(socket: MediaSocket, req: MediaRequest | undefined, opts: ServeOptions, isClosed: () => boolean): Promise<void> {
  if (!req) return fail(socket, 400, 'Bad request');
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(socket, 405, 'Only GET');
  const ref = refOfPath(req.path, opts.token);
  if (!ref) return fail(socket, 404, 'Not here');
  const { cache } = opts;
  const P = cache.piece;
  // The piece the range starts in tells the size; for a range from the end, the first piece does.
  const asked = /bytes\s*=\s*(\d+)/i.exec(req.headers.range ?? '');
  const firstGuess = asked ? Math.floor(Number(asked[1]) / P) : 0;
  let first: MediaPiece;
  try {
    first = await cache.get(ref, firstGuess);
  } catch (err) {
    return fail(socket, 502, err instanceof Error ? err.message : 'Your Mac did not send it');
  }
  const { size, mime } = first;
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    socket.write(head(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }));
    return socket.end();
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size ? end - start + 1 : 0;
  socket.write(
    head(range ? 206 : 200, {
      'Content-Type': mime,
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    }),
  );
  if (req.method === 'HEAD' || !length) return socket.end();
  const last = Math.floor(end / P);
  for (let i = Math.floor(start / P); i <= last; i++) {
    if (isClosed()) return;
    // A little ahead, so the link is busy while this piece is written.
    for (let k = 1; k <= MEDIA_READ_AHEAD && i + k <= last; k++) void cache.get(ref, i + k).catch(() => undefined);
    const got = i === firstGuess ? first : await cache.get(ref, i);
    const from = i === Math.floor(start / P) ? start - i * P : 0;
    const to = Math.min(got.bytes.length, end - i * P + 1);
    if (to <= from) return socket.destroy();
    if (isClosed()) return;
    if (!socket.write(got.bytes.subarray(from, to))) await drained(socket);
  }
  if (!isClosed()) socket.end();
}

/** Until the socket takes more (or goes). */
function drained(socket: MediaSocket): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      socket.removeListener('drain', done);
      socket.removeListener('close', done);
      resolve();
    };
    socket.on('drain', done);
    socket.on('close', done);
  });
}

/** A random token for the server's URLs (from the bytes given: the caller has the runtime's randomness). */
export const tokenOf = (random: Uint8Array): string => b4a.toString(random, 'hex');
