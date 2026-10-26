import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from '../../net/mesh/files.js';
import { type ShareMsg, parseShareFrame } from './protocol.js';

/**
 * How sharing messages reach a friend: over your mesh link to them. What must arrive waits in an
 * outbox (`~/.beluga/share-outbox.json`, 7 days) until their Mac acknowledges it, sent again every
 * 20 s while they're linked and at once when they come back, so nothing said while they were
 * offline is lost. Live progress (a Claude's streamed steps) only goes to someone linked now.
 */

/** What the courier needs from the mesh node. */
export interface ShareMesh {
  isLinked(peerId: string): boolean;
  sendShare(peerId: string, payload: unknown): boolean;
}

interface Waiting {
  readonly to: string;
  readonly frame: { readonly f: string; readonly m: ShareMsg };
  readonly at: number;
  /** A newer message with the same key replaces this one (a project's latest state). */
  readonly key?: string;
  sentAt?: number;
}

export const RESEND_MS = 20_000;
export const OUTBOX_DAYS = 7;
const MAX_WAITING = 2_000;
const SEEN_FRAMES = 1_000;

const newId = (): string => randomBytes(12).toString('base64url');

export class ShareCourier {
  private waiting: Waiting[] = [];
  private readonly seen = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly mesh: ShareMesh,
    private readonly file: string | undefined,
    /** A message that waited was taken by their Mac. */
    private readonly onAcked: (to: string, msg: ShareMsg) => void = () => undefined,
  ) {
    const saved = file ? readJson(file) : undefined;
    if (Array.isArray(saved)) {
      const cutoff = Date.now() - OUTBOX_DAYS * 86_400_000;
      this.waiting = saved.flatMap((w: Waiting) => {
        const frame = parseShareFrame(w?.frame);
        return frame && 'm' in frame && typeof w.to === 'string' && typeof w.at === 'number' && w.at > cutoff ? [{ to: w.to, frame, at: w.at, ...(w.key ? { key: w.key } : {}) }] : [];
      });
    }
  }

  start(): void {
    this.timer = setInterval(() => this.flush(), RESEND_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * Send a message. `reliable`: it waits until acknowledged. `key`: replaces what waits with the
   * same key for that person. Returns whether it left now (or, unreliable, whether it went at all).
   */
  send(to: string, m: ShareMsg, opts: { reliable: boolean; key?: string }): boolean {
    const frame = { f: newId(), m };
    const now = this.mesh.isLinked(to) && this.mesh.sendShare(to, frame);
    if (!opts.reliable) return now;
    if (opts.key) this.waiting = this.waiting.filter((w) => !(w.to === to && w.key === opts.key));
    this.waiting.push({ to, frame, at: Date.now(), ...(opts.key ? { key: opts.key } : {}), ...(now ? { sentAt: Date.now() } : {}) });
    if (this.waiting.length > MAX_WAITING) this.waiting = this.waiting.slice(-MAX_WAITING);
    this.save();
    return now;
  }

  /** Is this message still waiting for that person's Mac? */
  pending(to: string, match: (m: ShareMsg) => boolean): boolean {
    return this.waiting.some((w) => w.to === to && match(w.frame.m));
  }

  /** A frame from a friend: acks clear the outbox; a message is acknowledged and handed on once (with its frame id). */
  receive(from: string, raw: unknown): { readonly id: string; readonly m: ShareMsg } | undefined {
    const frame = parseShareFrame(raw);
    if (!frame) return undefined;
    if ('ack' in frame) {
      const i = this.waiting.findIndex((w) => w.to === from && w.frame.f === frame.ack);
      if (i >= 0) {
        const [done] = this.waiting.splice(i, 1);
        this.save();
        this.onAcked(from, done!.frame.m);
      }
      return undefined;
    }
    // Always acknowledged (the ack may be what got lost), handed on only once.
    this.mesh.sendShare(from, { ack: frame.f });
    const seen = this.seen.get(from) ?? new Set<string>();
    this.seen.set(from, seen);
    if (seen.has(frame.f)) return undefined;
    seen.add(frame.f);
    if (seen.size > SEEN_FRAMES) seen.delete(seen.values().next().value!);
    return { id: frame.f, m: frame.m };
  }

  /** Send what waits (for one person, or everyone linked); `force`: even what went moments ago. */
  flush(to?: string, force = false): void {
    const now = Date.now();
    const cutoff = now - OUTBOX_DAYS * 86_400_000;
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.at > cutoff);
    for (const w of this.waiting) {
      if (to && w.to !== to) continue;
      if (!force && w.sentAt && now - w.sentAt < RESEND_MS) continue;
      if (this.mesh.isLinked(w.to) && this.mesh.sendShare(w.to, w.frame)) w.sentAt = now;
    }
    if (this.waiting.length !== before) this.save();
  }

  /** Forget what waits for someone (they're no longer a friend). */
  drop(to: string): void {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.to !== to);
    if (this.waiting.length !== before) this.save();
  }

  private save(): void {
    if (!this.file) return;
    try {
      writeJson(this.file, this.waiting.map(({ to, frame, at, key }) => ({ to, frame, at, ...(key ? { key } : {}) })));
    } catch {
      // Best effort: what waits is still in memory.
    }
  }
}
