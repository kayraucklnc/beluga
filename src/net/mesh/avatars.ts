import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from './files.js';

/**
 * Profile pictures: yours, and the ones friends and people in your groups told you about, kept
 * under `dir` (normally ~/.beluga/avatars) by checksum, so a picture comes over the network once
 * per change and still shows while its owner is away. index.json says which one is yours and
 * which one each person said is theirs last.
 */

/** The biggest picture kept or sent (the Mac shrinks one to 256 px first, usually 10–40 KB). */
export const AVATAR_MAX = 96 * 1024;

const SHA = /^[0-9a-f]{64}$/;
const PEER = /^[\w-]{32}$/;

/** What kind of picture these bytes are, by their first bytes; undefined for anything else. */
export function avatarMime(bytes: Uint8Array): string | undefined {
  const at = (i: number, ...b: number[]): boolean => b.every((v, j) => bytes[i + j] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface Index {
  mine?: string;
  theirs: Record<string, string>;
}

export class AvatarBook {
  private index: Index;

  constructor(private readonly dir: string) {
    const raw = readJson(path.join(dir, 'index.json')) as Partial<Index> | undefined;
    const theirs = raw && typeof raw.theirs === 'object' && raw.theirs ? Object.fromEntries(Object.entries(raw.theirs).filter(([p, s]) => PEER.test(p) && typeof s === 'string' && SHA.test(s))) : {};
    const mine = typeof raw?.mine === 'string' && SHA.test(raw.mine) && this.has(raw.mine) ? raw.mine : undefined;
    this.index = { ...(mine ? { mine } : {}), theirs };
  }

  /** Your picture's checksum, if you set one. */
  get mine(): string | undefined {
    return this.index.mine;
  }

  /** Set your picture (or take it away with undefined): → its checksum. Throws for anything that isn't a small picture. */
  setMine(bytes: Uint8Array | undefined): string | undefined {
    const sha = bytes ? this.keep(bytes) : undefined;
    if (!sha && bytes) throw new Error(`Pick a PNG, JPEG, WebP or GIF picture under ${AVATAR_MAX / 1024} KB`);
    const old = this.index.mine;
    this.index = { ...(sha ? { mine: sha } : {}), theirs: this.index.theirs };
    this.save();
    if (old && old !== sha) this.dropIfUnused(old);
    return sha;
  }

  /** The picture someone said is theirs (kept while they're away). */
  theirs(peerId: string): string | undefined {
    return this.index.theirs[peerId];
  }

  /** Someone said which picture is theirs (or that they have none): true when that changed. */
  announce(peerId: string, sha: string | undefined): boolean {
    const old = this.index.theirs[peerId];
    if (old === sha) return false;
    const theirs = { ...this.index.theirs };
    if (sha) theirs[peerId] = sha;
    else delete theirs[peerId];
    this.index = { ...this.index, theirs };
    this.save();
    if (old) this.dropIfUnused(old);
    return true;
  }

  /** Keep a picture that came from someone: only the one they said is theirs, and only if it checks out. */
  receive(peerId: string, sha: string, bytes: Uint8Array): boolean {
    if (this.index.theirs[peerId] !== sha || shaOf(bytes) !== sha) return false;
    return this.keep(bytes) === sha;
  }

  has(sha: string): boolean {
    return SHA.test(sha) && this.read(sha) !== undefined;
  }

  /** A picture's bytes and type, if it's here. */
  read(sha: string): { readonly mime: string; readonly bytes: Buffer } | undefined {
    if (!SHA.test(sha)) return undefined;
    try {
      const bytes = readFileSync(path.join(this.dir, sha));
      const mime = avatarMime(bytes);
      return mime && bytes.length <= AVATAR_MAX ? { mime, bytes } : undefined;
    } catch {
      return undefined;
    }
  }

  private keep(bytes: Uint8Array): string | undefined {
    if (bytes.length === 0 || bytes.length > AVATAR_MAX || !avatarMime(bytes)) return undefined;
    const sha = shaOf(bytes);
    if (this.has(sha)) return sha;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, sha);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
    return sha;
  }

  private dropIfUnused(sha: string): void {
    if (this.index.mine === sha || Object.values(this.index.theirs).includes(sha)) return;
    rmSync(path.join(this.dir, sha), { force: true });
  }

  private save(): void {
    writeJson(path.join(this.dir, 'index.json'), this.index);
  }
}
