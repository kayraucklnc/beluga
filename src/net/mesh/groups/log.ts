import { appendLine, readLines, writeLines } from '../files.js';
import { verifyCard } from '../keys.js';
import type { Entry, Profile } from '../schemas.js';
import { bodyOf, byOrder, groupIdOf, verifySignature, wellFormed } from './entry.js';

/**
 * One group's log on this Mac: every entry checked (shape, id, signature, causal parents) before
 * it's kept, kept in a file (one entry per line, append-only), and handed out to members who
 * are missing some. Entries whose parents haven't arrived yet wait (bounded) until they do.
 */

/** Bytes of out-of-order entries that may wait for their parents (less for a group being fetched). */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const PROBE_PENDING_BYTES = 512 * 1024;

export interface AddResult {
  /** Entries newly kept (the one given, and any waiting ones it completed), in the order kept. */
  readonly added: readonly Entry[];
  /** The entry was refused: malformed, forged, or for another group. */
  readonly rejected: boolean;
}

export class GroupLog {
  private readonly entries = new Map<string, Entry>();
  private readonly children = new Map<string, number>();
  private readonly pending = new Map<string, { entry: Entry; bytes: number }>();
  private pendingBytes = 0;
  /**
   * Who may introduce people (their cards become trusted for checking signatures): the engine
   * says whether an add's author is an admin, so a plain member can't conjure up authors.
   * Unset while loading your own file.
   */
  canIntroduce: ((e: Entry) => boolean) | undefined;
  private readonly profiles = new Map<string, Profile>();
  private sorted: Entry[] | undefined;
  private loading = false;

  /** `file`: where the log is kept (none: memory only). */
  constructor(
    readonly groupId: string,
    private readonly file?: string,
    private readonly maxPendingBytes = MAX_PENDING_BYTES,
  ) {}

  static load(groupId: string, file: string): GroupLog {
    const log = new GroupLog(groupId, file);
    log.loading = true;
    for (const raw of readLines(file)) log.add(raw);
    log.loading = false;
    return log;
  }

  get size(): number {
    return this.entries.size;
  }

  has = (id: string): boolean => this.entries.has(id);
  get = (id: string): Entry | undefined => this.entries.get(id);
  profile = (peerId: string): Profile | undefined => this.profiles.get(peerId);

  /** Entries nothing else points to yet: what a new entry names as its parents. */
  heads(): string[] {
    return [...this.entries.keys()].filter((id) => !this.children.get(id)).sort();
  }

  /** Every entry, in the order every copy agrees on. */
  ordered(): readonly Entry[] {
    this.sorted ??= [...this.entries.values()].sort(byOrder);
    return this.sorted;
  }

  /** Parents some waiting entries need and nobody has sent yet. */
  missing(): string[] {
    const out = new Set<string>();
    for (const { entry: e } of this.pending.values()) for (const p of e.parents) if (!this.entries.has(p) && !this.pending.has(p)) out.add(p);
    return [...out];
  }

  add(raw: unknown): AddResult {
    const e = wellFormed(raw);
    if (!e || !this.belongs(e)) return { added: [], rejected: true };
    if (this.entries.has(e.id)) return { added: [], rejected: false };
    const author = this.keyFor(e);
    // A known author's signature is checked right away, even if the entry has to wait.
    if (author && !verifySignature(e, author.card.publicKey)) return { added: [], rejected: true };
    if (!author || !e.parents.every((p) => this.entries.has(p))) {
      this.hold(e);
      return { added: [], rejected: false };
    }
    if (!this.check(e)) return { added: [], rejected: true };
    const added = [e];
    this.keep(e);
    // Anything that was waiting on it may be complete now.
    for (let progress = true; progress && this.pending.size; ) {
      progress = false;
      for (const { entry: w, bytes } of [...this.pending.values()]) {
        if (!w.parents.every((p) => this.entries.has(p)) || !this.keyFor(w)) continue;
        this.pending.delete(w.id);
        this.pendingBytes -= bytes;
        if (!this.check(w)) continue;
        this.keep(w);
        added.push(w);
        progress = true;
      }
    }
    return { added, rejected: false };
  }

  /**
   * What someone whose newest entries are `theirHeads` doesn't have yet, oldest first (so they
   * can check each one as it arrives), at most `limit` entries.
   */
  missingFor(theirHeads: readonly string[], limit: number, upTo?: string): { entries: Entry[]; more: boolean } {
    const theirs = this.ancestors(theirHeads);
    // Someone who was removed only gets as far as their removal.
    const allowed = upTo ? this.ancestors([upTo]) : undefined;
    const out = this.ordered().filter((e) => !theirs.has(e.id) && (!allowed || allowed.has(e.id)));
    return { entries: out.slice(0, limit), more: out.length > limit };
  }

  /** These entries and everything before them (the ones we have). */
  ancestors(ids: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = ids.filter((id) => this.entries.has(id));
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const p of this.entries.get(id)?.parents ?? []) if (!seen.has(p)) stack.push(p);
    }
    return seen;
  }

  /** Start keeping a log that was only in memory (a group you turned out to be in). */
  persistTo(file: string): GroupLog {
    const log = new GroupLog(this.groupId, file);
    writeLines(file, this.ordered());
    log.loading = true;
    for (const e of this.ordered()) log.add(e);
    log.loading = false;
    return log;
  }

  private hold(e: Entry): void {
    if (this.pending.has(e.id)) return;
    const bytes = JSON.stringify(e).length;
    if (this.pendingBytes + bytes > this.maxPendingBytes) return;
    this.pending.set(e.id, { entry: e, bytes });
    this.pendingBytes += bytes;
  }

  private belongs(e: Entry): boolean {
    return e.type === 'create' ? groupIdOf(e.id) === this.groupId : e.group === this.groupId;
  }

  private keyFor(e: Entry): Profile | undefined {
    if (e.type === 'create') return bodyOf(e, 'create').creator;
    return this.profiles.get(e.author);
  }

  /** Signature, Lamport clock and any cards it carries are right. */
  private check(e: Entry): boolean {
    const author = this.keyFor(e);
    if (!author || author.card.peerId !== e.author || !verifySignature(e, author.card.publicKey)) return false;
    if (e.type === 'create') return verifyCard(author.card);
    const top = Math.max(...e.parents.map((p) => this.entries.get(p)!.lamport));
    if (e.lamport !== top + 1) return false;
    return e.type !== 'member_add' || verifyCard(bodyOf(e, 'member_add').member.card);
  }

  private keep(e: Entry): void {
    this.entries.set(e.id, e);
    for (const p of e.parents) this.children.set(p, (this.children.get(p) ?? 0) + 1);
    if (e.type === 'create') this.profiles.set(e.author, bodyOf(e, 'create').creator);
    if (e.type === 'member_add' && (this.loading || !this.canIntroduce || this.canIntroduce(e))) {
      const { member } = bodyOf(e, 'member_add');
      if (!this.profiles.has(member.card.peerId)) this.profiles.set(member.card.peerId, member);
    }
    this.sorted = undefined;
    if (this.file && !this.loading) appendLine(this.file, e);
  }
}
