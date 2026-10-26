import { randomBytes } from 'node:crypto';
import type { BelugaInfo } from '../../net/mesh/features.js';
import type { ChatExtras } from '../../net/mesh/views.js';
import type { TaskBook } from './book.js';
import { type Frame, type GatewayMsg, type GatewayMsgInput, parseFrame } from './protocol.js';

/**
 * How gateway messages reach a person: over your mesh link to them when they're a friend
 * who's online, else through today's room when they're in it. Requests, results and cancels
 * wait in the outbox until the other side acknowledges them (resent now and then while there's
 * no ack, delivered when they come back online); progress updates and cards are only sent when
 * someone is reachable right now.
 */

/** What the gateway needs from the mesh node (net/mesh/mesh.ts). */
export interface MeshPort {
  readonly peerId: string;
  isFriend(peerId: string): boolean;
  isLinked(peerId: string): boolean;
  /** Hand a frame to the friend's link; false when there's no link now. */
  sendGateway(peerId: string, payload: unknown): boolean;
  nameFor(peerId: string): string;
  /** What their Beluga said about itself (its version and features); undefined for older Macs. */
  belugaOf?(peerId: string): BelugaInfo | undefined;
  /** Write in a conversation you share (`dm:<peerId>`, `group:<id>`): a task's card there (BLG-208). */
  post?(conversation: string, text: string, extras: ChatExtras): void;
  /** `peerId` is in this conversation with you now. */
  shares?(conversation: string, peerId: string): boolean;
}

/** What the gateway needs from today's room. */
export interface RoomPort {
  /** They're in the room right now. */
  present(peerId: string): boolean;
  send(peerId: string, frame: Frame): boolean;
}

export type Via = 'mesh' | 'room';

/** Resend a frame nobody acknowledged after this long (while they're reachable). */
export const RESEND_MS = 20_000;

const frameId = (): string => randomBytes(12).toString('base64url');

/** Frame ids remembered per person, to drop a frame that comes twice (a resend whose ack was lost). */
const SEEN_FRAMES = 1000;

export class Courier {
  private readonly seen = new Map<string, Set<string>>();

  constructor(
    private readonly book: TaskBook,
    private readonly ports: { readonly mesh: () => MeshPort | undefined; readonly room: () => RoomPort | undefined },
  ) {}

  /** How this person can be reached right now, if at all. */
  reach(peerId: string): Via | undefined {
    const mesh = this.ports.mesh();
    if (mesh?.isFriend(peerId) && mesh.isLinked(peerId)) return 'mesh';
    if (this.ports.room()?.present(peerId)) return 'room';
    return undefined;
  }

  /** Can this person be sent anything at all, now or later (a friend, or someone in the room)? */
  knows(peerId: string): boolean {
    return Boolean(this.ports.mesh()?.isFriend(peerId) || this.ports.room()?.present(peerId));
  }

  /**
   * Send a message. `reliable`: kept in the outbox until acknowledged (only for friends, or
   * someone in the room now). Returns whether it left right away.
   */
  send(to: string, msg: GatewayMsgInput, reliable: boolean): boolean {
    const frame = { f: frameId(), m: msg as GatewayMsg };
    const now = this.deliver(to, frame);
    if (reliable) this.book.queue(to, frame, now ? Date.now() : undefined);
    return now;
  }

  /** Acknowledge a frame and hand its message on; acks clear the outbox. */
  receive(from: string, via: Via, raw: unknown): GatewayMsg | undefined {
    const frame = parseFrame(raw);
    if (!frame) return undefined;
    if ('ack' in frame) {
      this.book.acked(from, frame.ack);
      return undefined;
    }
    // Always acknowledged (the ack may be what got lost), handed on only once.
    this.deliverVia(from, via, { ack: frame.f });
    const seen = this.seen.get(from) ?? new Set<string>();
    this.seen.set(from, seen);
    if (seen.has(frame.f)) return undefined;
    seen.add(frame.f);
    if (seen.size > SEEN_FRAMES) seen.delete(seen.values().next().value!);
    return frame.m;
  }

  /** Send what waits for this person (or everyone reachable); `force` resends even recent ones. */
  flush(to?: string, force = false): void {
    const now = Date.now();
    for (const o of this.book.waiting(to, now)) {
      if (!force && o.sentAt && now - o.sentAt < RESEND_MS) continue;
      if (this.deliver(o.to, o.frame)) this.book.handed(o.frame.f, now);
    }
  }

  private deliver(to: string, frame: Frame): boolean {
    const via = this.reach(to);
    return via ? this.deliverVia(to, via, frame) : false;
  }

  private deliverVia(to: string, via: Via, frame: Frame): boolean {
    if (via === 'mesh') return this.ports.mesh()?.sendGateway(to, frame) ?? false;
    return this.ports.room()?.send(to, frame) ?? false;
  }
}
