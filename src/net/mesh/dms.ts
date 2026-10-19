import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { appendLine, readJson, readLines, safeName, writeJson } from './files.js';

/**
 * Direct messages with friends: each conversation kept in ~/.klaud/dms/<peer>.jsonl, and what
 * you sent while they were offline in your outbox (~/.klaud/outbox.json) until their Mac says
 * it got it, or until it expires.
 */

export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OUTBOX = 2_000;

export interface Dm {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly ts: number;
}

const DmLine = z.union([
  z.object({ id: z.string(), from: z.string(), to: z.string(), text: z.string(), ts: z.number() }),
  z.object({ ack: z.string() }),
  z.object({ expired: z.string() }),
]);

const Outgoing = z.object({ id: z.string(), from: z.string(), to: z.string(), text: z.string(), ts: z.number(), expiresAt: z.number() });
type Outgoing = z.infer<typeof Outgoing>;

export interface DmStatus {
  readonly delivered: ReadonlySet<string>;
  readonly expired: ReadonlySet<string>;
}

interface Conversation {
  readonly messages: Dm[];
  readonly ids: Set<string>;
  readonly delivered: Set<string>;
  readonly expired: Set<string>;
}

export class DmBook {
  private readonly conversations = new Map<string, Conversation>();
  private outbox: readonly Outgoing[];

  constructor(private readonly dir: string) {
    const raw = readJson(path.join(dir, 'outbox.json'));
    this.outbox = (Array.isArray(raw) ? raw : []).flatMap((o) => {
      const parsed = Outgoing.safeParse(o);
      return parsed.success ? [parsed.data] : [];
    });
  }

  /** A conversation's messages, oldest first. */
  history(peerId: string): readonly Dm[] {
    return this.load(peerId).messages;
  }

  status(peerId: string): DmStatus {
    return this.load(peerId);
  }

  /** Waiting in the outbox for this friend. */
  waiting(peerId: string): readonly Outgoing[] {
    return this.outbox.filter((o) => o.to === peerId && o.expiresAt > Date.now());
  }

  /** Write a message to a friend: kept in the conversation and in the outbox until they confirm. */
  compose(from: string, to: string, text: string): Dm {
    if (this.outbox.length >= MAX_OUTBOX) throw new Error('Your outbox is full; wait for friends to come online');
    const dm: Dm = { id: randomBytes(12).toString('base64url'), from, to, text, ts: Date.now() };
    this.record(to, dm);
    this.saveOutbox([...this.outbox, { ...dm, expiresAt: dm.ts + OUTBOX_TTL_MS }]);
    return dm;
  }

  /** A message from a friend; false when it's one we already have. */
  receive(dm: Dm): boolean {
    const c = this.load(dm.from);
    if (c.ids.has(dm.id)) return false;
    this.record(dm.from, dm);
    return true;
  }

  /** They got it: off the outbox. Returns the message when it was ours and waiting. */
  delivered(peerId: string, id: string): Dm | undefined {
    const waiting = this.outbox.find((o) => o.id === id && o.to === peerId);
    if (!waiting) return undefined;
    this.saveOutbox(this.outbox.filter((o) => o !== waiting));
    const c = this.load(peerId);
    c.delivered.add(id);
    appendLine(this.file(peerId), { ack: id });
    return c.messages.find((m) => m.id === id);
  }

  /** Drop what waited too long; returns what expired. */
  expire(now = Date.now()): Dm[] {
    const gone = this.outbox.filter((o) => o.expiresAt <= now);
    if (!gone.length) return [];
    this.saveOutbox(this.outbox.filter((o) => o.expiresAt > now));
    return gone.map((o) => {
      const c = this.load(o.to);
      c.expired.add(o.id);
      appendLine(this.file(o.to), { expired: o.id });
      return { id: o.id, from: o.from, to: o.to, text: o.text, ts: o.ts };
    });
  }

  /** Forget a friend's conversation in memory and drop what waits for them (the file stays). */
  forget(peerId: string): void {
    this.conversations.delete(peerId);
    this.saveOutbox(this.outbox.filter((o) => o.to !== peerId));
  }

  private file(peerId: string): string {
    return path.join(this.dir, 'dms', `${safeName(peerId)}.jsonl`);
  }

  private record(peerId: string, dm: Dm): void {
    const c = this.load(peerId);
    c.messages.push(dm);
    c.ids.add(dm.id);
    appendLine(this.file(peerId), dm);
  }

  private load(peerId: string): Conversation {
    const known = this.conversations.get(peerId);
    if (known) return known;
    const c: Conversation = { messages: [], ids: new Set(), delivered: new Set(), expired: new Set() };
    for (const raw of readLines(this.file(peerId))) {
      const line = DmLine.safeParse(raw);
      if (!line.success) continue;
      const v = line.data;
      if ('ack' in v) c.delivered.add(v.ack);
      else if ('expired' in v) c.expired.add(v.expired);
      else if (!c.ids.has(v.id)) {
        c.messages.push(v);
        c.ids.add(v.id);
      }
    }
    this.conversations.set(peerId, c);
    return c;
  }

  private saveOutbox(next: readonly Outgoing[]): void {
    this.outbox = next;
    writeJson(path.join(this.dir, 'outbox.json'), next);
  }
}
