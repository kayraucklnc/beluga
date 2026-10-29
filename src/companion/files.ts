import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isArtifact, outputKind } from '../core/claude-code/outputs.js';
import { isSecretPath } from '../core/shares.js';
import { redactSecrets } from '../shared/steps.js';
import { COMPANION_PIECE, type OutputView } from './protocol.js';

/**
 * Files on the phone travel only as refs: a view hands out `out:<random>` for a path on the Mac,
 * the phone asks for `get {ref, variant, off}`, and the Mac resolves it here, checking again
 * before a byte is read that it's an output (`isArtifact`: pictures anywhere, text outside the
 * project or where outputs go; never source code) and not a secret (`isSecretPath`, by the path
 * given and where it really leads). The phone never learns a path.
 *
 * Variants: `thumb` (a picture's longest side 640 px, or a video's first frame (Quick Look), JPEG, made with `sips` and cached under
 * ~/.beluga/companion/thumbs), `full` (the bytes), `text` (a text output, secrets redacted). Each
 * answer is one piece of at most COMPANION_PIECE bytes from `off`; the phone asks for the next.
 *
 * A kept table's document or storage object (BLG-386) is a ref too (`docRef`): it names the cell,
 * never a path, and its bytes come from Sentinel when it's fetched (a storage object fetched then
 * through a link signed on the Mac, held in memory a moment for its pieces). Text goes redacted.
 */

/** Refs kept (the oldest go first: views hand them out again when they're still shown). */
const MAX_REFS = 5_000;

/** A typed cell of a kept table (a sentinel's metric, its column and the cell's value). */
export interface DocKey {
  readonly sentinelId: string;
  readonly metric: string;
  readonly column: string;
  readonly value: string;
}

type RefEntry = { readonly path: string; readonly cwd?: string; readonly doc?: undefined } | { readonly doc: DocKey; readonly path?: undefined; readonly cwd?: undefined };

/** A document's bytes, from Sentinel (Sentinels.documentBytes). */
export type DocumentBytes = (doc: DocKey) => Promise<{ readonly name: string; readonly mime: string; readonly bytes: Uint8Array }>;

const docText = (mime: string): boolean => mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml';

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
};
export const mimeOf = (p: string): string => MIME[path.extname(p).toLowerCase()] ?? (outputKind(p) === 'text' ? 'text/plain' : 'application/octet-stream');

/** Where a path really is (links resolved), or the path itself when it's gone. */
const realOf = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** May the phone see this file at all: an output, and no secret by its path or where it leads. */
export function allowed(p: string, cwd?: string): boolean {
  if (!isArtifact(p, cwd) || isSecretPath(p)) return false;
  const real = realOf(p);
  return real === p || (!isSecretPath(real) && isArtifact(real, cwd ? realOf(cwd) : undefined));
}

/** Paths handed out as refs: the same path keeps its ref, so a view that didn't change hashes the same. */
export class RefTable {
  private readonly byRef = new Map<string, RefEntry>();
  private readonly byPath = new Map<string, string>();

  constructor(private readonly random: () => string = () => randomBytes(12).toString('base64url')) {}

  /** The ref for a path, or undefined when it may not go to the phone (checked only by name here; again when it's fetched). */
  refFor(p: string, cwd?: string): string | undefined {
    if (!isArtifact(p, cwd) || isSecretPath(p)) return undefined;
    const known = this.byPath.get(p);
    if (known) return known;
    const ref = `out:${this.random()}`;
    this.byRef.set(ref, { path: p, ...(cwd ? { cwd } : {}) });
    this.byPath.set(p, ref);
    this.trim();
    return ref;
  }

  /** The ref for a kept table's typed cell: the same cell keeps its ref. */
  docRef(doc: DocKey): string {
    const key = `doc\u0000${doc.sentinelId}\u0000${doc.metric}\u0000${doc.column}\u0000${doc.value}`;
    const known = this.byPath.get(key);
    if (known) return known;
    const ref = `out:${this.random()}`;
    this.byRef.set(ref, { doc });
    this.byPath.set(key, ref);
    this.trim();
    return ref;
  }

  private trim(): void {
    if (this.byRef.size <= MAX_REFS) return;
    const [oldest] = this.byRef.entries().next().value as [string, RefEntry];
    this.byRef.delete(oldest);
    for (const [k, v] of this.byPath) if (v === oldest) this.byPath.delete(k);
  }

  /** An output as a view shows it, or undefined when it may not go to the phone. */
  output(p: string, extra: { size?: number; ts?: number; by?: string; cwd?: string } = {}): OutputView | undefined {
    const ref = this.refFor(p, extra.cwd);
    if (!ref) return undefined;
    return {
      ref,
      name: path.basename(p).slice(0, 256),
      kind: outputKind(p),
      ...(extra.size !== undefined ? { size: Math.max(0, Math.round(extra.size)) } : {}),
      ...(extra.ts !== undefined ? { ts: Math.max(0, Math.round(extra.ts)) } : {}),
      ...(extra.by ? { by: extra.by.slice(0, 200) } : {}),
    };
  }

  resolve(ref: string): RefEntry | undefined {
    return this.byRef.get(ref);
  }
}

export type Variant = 'thumb' | 'full' | 'text';

export interface Piece {
  readonly off: number;
  readonly b64: string;
  readonly eof: boolean;
  /** The whole thing's size (the thumbnail's, for a thumb). */
  readonly size: number;
  readonly mime: string;
}

/** Makes a thumbnail of `src` at `dest` (JPEG, longest side 640 px). */
export type Thumbnailer = (src: string, dest: string) => Promise<void>;

/** macOS's own image tool: no dependency, handles every picture format the Mac does. */
export const sipsThumbnailer: Thumbnailer = (src, dest) =>
  new Promise((resolve, reject) => {
    execFile('sips', ['-Z', '640', '-s', 'format', 'jpeg', src, '--out', dest], { timeout: 20_000 }, (err) => (err ? reject(new Error('Could not make a thumbnail')) : resolve()));
  });

/**
 * A video's poster frame, the way Finder makes it (Quick Look), then a JPEG like a picture's. Only
 * the formats Quick Look draws (MP4, M4V, MOV): it can hang on others, so it's never asked, and
 * it's stopped after a while.
 */
export const quickLookPoster: Thumbnailer = async (src, dest) => {
  if (!/\.(mp4|m4v|mov)$/i.test(src)) throw new Error('No poster for this kind of video');
  const dir = await mkdtemp(path.join(path.dirname(dest), 'ql-'));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('qlmanage', ['-t', '-s', '640', '-o', dir, src], { timeout: 15_000 }, (err) => (err ? reject(new Error('Could not make a poster')) : resolve()));
    });
    const made = (await readdir(dir)).find((n) => n.endsWith('.png'));
    if (!made) throw new Error('Could not make a poster');
    await sipsThumbnailer(path.join(dir, made), dest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface FileServerOptions {
  readonly refs: RefTable;
  /** ~/.beluga/companion/thumbs */
  readonly thumbsDir: string;
  readonly thumbnail?: Thumbnailer;
  /** A video's poster frame (quickLookPoster). */
  readonly poster?: Thumbnailer;
  /** A kept table's documents (Sentinel's); none: their refs don't open. */
  readonly documents?: DocumentBytes;
}

async function readPiece(file: string, off: number, max: number): Promise<{ bytes: Buffer; size: number }> {
  const handle = await open(file, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error('Not a file');
    const len = Math.max(0, Math.min(max, st.size - off));
    const bytes = Buffer.alloc(len);
    if (len) await handle.read(bytes, 0, len, off);
    return { bytes, size: st.size };
  } finally {
    await handle.close();
  }
}

/** Answers the phone's `get`: one piece of an output, checked again first. */
export class FileServer {
  private readonly making = new Map<string, Promise<string>>();

  constructor(private readonly opts: FileServerOptions) {}

  async piece(ref: string, variant: Variant, off: number): Promise<Piece> {
    const entry = this.opts.refs.resolve(ref);
    if (!entry) throw new Error('That file is no longer offered; pull to refresh');
    if (entry.doc) return this.docPiece(entry.doc, variant, off);
    if (!allowed(entry.path, entry.cwd)) throw new Error("That file can't be opened on the phone");
    const kind = outputKind(entry.path);
    if (variant === 'thumb') {
      if (kind !== 'image' && kind !== 'video') throw new Error('Only pictures and videos have thumbnails');
      const thumb = await this.thumb(entry.path, kind === 'video' ? (this.opts.poster ?? quickLookPoster) : (this.opts.thumbnail ?? sipsThumbnailer));
      const { bytes, size } = await readPiece(thumb, off, COMPANION_PIECE);
      return { off, b64: bytes.toString('base64'), eof: off + bytes.length >= size, size, mime: 'image/jpeg' };
    }
    if (variant === 'text') {
      if (kind !== 'text' && kind !== 'json' && kind !== 'markdown') throw new Error('That file is not text');
      const { bytes, size } = await readPiece(entry.path, off, COMPANION_PIECE);
      // Secrets a log printed stay on the Mac (the same redaction as steps and outputs on the Mac).
      const text = redactSecrets(bytes.toString('utf8'));
      return { off, b64: Buffer.from(text, 'utf8').toString('base64').slice(0, Math.ceil(COMPANION_PIECE / 3) * 4), eof: off + bytes.length >= size, size, mime: mimeOf(entry.path) };
    }
    // A text output only ever leaves redacted (`text`): never its raw bytes, which a save would keep (BLG-123).
    if (kind === 'text' || kind === 'json' || kind === 'markdown') throw new Error('Text files come redacted: ask for its text');
    const { bytes, size } = await readPiece(entry.path, off, COMPANION_PIECE);
    return { off, b64: bytes.toString('base64'), eof: off + bytes.length >= size, size, mime: mimeOf(entry.path) };
  }

  /** One piece of a kept table's document: text redacted, as any text output; a picture is its own thumbnail. */
  private async docPiece(doc: DocKey, variant: Variant, off: number): Promise<Piece> {
    if (!this.opts.documents) throw new Error('Documents open on the Mac');
    const { mime, bytes } = await this.opts.documents(doc);
    if (variant === 'text') {
      if (!docText(mime)) throw new Error('That file is not text');
      const part = Buffer.from(bytes.subarray(off, off + COMPANION_PIECE));
      const text = redactSecrets(part.toString('utf8'));
      return { off, b64: Buffer.from(text, 'utf8').toString('base64').slice(0, Math.ceil(COMPANION_PIECE / 3) * 4), eof: off + part.length >= bytes.byteLength, size: bytes.byteLength, mime };
    }
    if (docText(mime)) throw new Error('Text files come redacted: ask for its text');
    if (variant === 'thumb' && !mime.startsWith('image/')) throw new Error('Only pictures have thumbnails here');
    const part = Buffer.from(bytes.subarray(off, off + COMPANION_PIECE));
    return { off, b64: part.toString('base64'), eof: off + part.length >= bytes.byteLength, size: bytes.byteLength, mime };
  }

  /** The cached thumbnail of a picture (made once per version of the file). */
  private async thumb(src: string, make: Thumbnailer): Promise<string> {
    const st = await stat(src);
    const key = createHash('sha256').update(`${src}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 32);
    const dest = path.join(this.opts.thumbsDir, `${key}.jpg`);
    try {
      if ((await stat(dest)).size > 0) return dest;
    } catch {
      // not made yet
    }
    let pending = this.making.get(dest);
    if (!pending) {
      mkdirSync(this.opts.thumbsDir, { recursive: true, mode: 0o700 });
      pending = make(src, dest).then(() => dest);
      this.making.set(dest, pending);
      void pending.finally(() => this.making.delete(dest)).catch(() => undefined);
    }
    return pending;
  }
}
