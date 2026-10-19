import { EventEmitter } from 'node:events';
import type { MessageSocket } from '../transport.js';
import { type LinkMessage, parseLink } from './wire.js';

/** Why a link was closed (close codes travel in the close frame, see transport.ts). */
export const CLOSE = { duplicate: 4000, notAllowed: 4001, version: 4002, flooding: 4029, quiet: 4008 } as const;

/** Messages per second a link may carry on average, and in a burst. */
const RATE = 300;
const BURST = 1_500;
/** Bytes per second on average, and in a burst (catching up on a group sends a lot at once). */
const BYTE_RATE = 4 * 1024 * 1024;
const BYTE_BURST = 32 * 1024 * 1024;
/** Messages dropped for flooding before the link is closed. */
const MAX_DROPS = 3_000;

/** A token bucket: lets bursts through, then holds to an average rate. */
export class Bucket {
  private tokens: number;
  private at = Date.now();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(cost = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

interface LinkEvents {
  message: [LinkMessage];
  close: [number];
}

/**
 * An authenticated, encrypted connection to one person's Mac: direct, or through another
 * member's Mac (a relay that only sees ciphertext). Rate-limited, and closed when the other
 * side goes quiet (no pong for a while).
 */
export class MeshLink extends EventEmitter<LinkEvents> {
  readonly openedAt = Date.now();
  private readonly bucket = new Bucket(RATE, BURST);
  private readonly bytes = new Bucket(BYTE_RATE, BYTE_BURST);
  private drops = 0;
  private heard = Date.now();
  private readonly beat: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly peerId: string,
    private readonly socket: MessageSocket,
    /** You opened this connection (decides which of two simultaneous ones is kept). */
    readonly outgoing: boolean,
    readonly via: 'direct' | 'relay',
    pingMs: number,
  ) {
    super();
    socket.on('message', (text) => this.onText(text));
    socket.on('pong', () => (this.heard = Date.now()));
    socket.on('close', (code) => this.finish(code));
    socket.on('error', () => undefined);
    this.beat = setInterval(() => {
      if (Date.now() - this.heard > pingMs * 3) socket.terminate();
      else socket.ping();
    }, pingMs);
    this.beat.unref();
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.isOpen;
  }

  send(msg: LinkMessage): void {
    if (this.isOpen) this.socket.send(JSON.stringify(msg));
  }

  close(code: number = CLOSE.quiet, reason = ''): void {
    this.socket.close(code, reason);
  }

  terminate(): void {
    this.socket.terminate();
  }

  private onText(text: string): void {
    this.heard = Date.now();
    if (!this.bucket.take() || !this.bytes.take(text.length)) {
      this.drops += 1;
      if (this.drops > MAX_DROPS) this.close(CLOSE.flooding, 'too many messages');
      return;
    }
    const msg = parseLink(text);
    if (msg) this.emit('message', msg);
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.beat);
    this.emit('close', code);
  }
}
