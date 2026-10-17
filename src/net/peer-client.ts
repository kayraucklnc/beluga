import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import {
  Body,
  type BodyInput,
  type Frame,
  type MsgFrame,
  type PeerInfo,
  PeerInfo as PeerInfoSchema,
  type Profile,
  WelcomePayload,
  parseFrame,
} from '../protocol.js';
import { type RoomKeys, open, proveNonce, seal } from './crypto.js';

const SealedMessage = z.object({ f: z.string(), b: Body });
const HEARTBEAT_MS = 25_000;
const SEEN_LIMIT = 10_000;
/** Hub rejections that retrying won't fix: bad secret, bad profile, room full. */
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4004]);

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface IncomingMessage {
  /** Unique per message (the AES-GCM IV), stable across history replays. */
  readonly id: string;
  readonly from: string;
  readonly ts: number;
  readonly body: Body;
}

interface ClientEvents {
  status: [ConnectionStatus];
  welcome: [PeerInfo, string | undefined];
  peers: [readonly PeerInfo[]];
  message: [IncomingMessage];
  error: [string];
}

export interface PeerClientOptions {
  readonly url: string;
  readonly keys: RoomKeys;
  readonly profile: Profile;
  readonly peerId?: string;
  readonly reconnect?: boolean;
}

/** One participant's connection to the room hub. Handles auth, E2E crypto and reconnects. */
export class PeerClient extends EventEmitter<ClientEvents> {
  readonly peerId: string;
  private ws?: WebSocket;
  private profile: Profile;
  private closed = false;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private ready = false;
  private heartbeat?: NodeJS.Timeout;
  private alive = true;
  private readonly seen = new Set<string>();

  constructor(private readonly opts: PeerClientOptions) {
    super();
    this.peerId = opts.peerId ?? randomUUID();
    this.profile = opts.profile;
  }

  connect(): void {
    this.closed = false;
    this.emit('status', 'connecting');
    const ws = new WebSocket(this.opts.url, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on('open', () => this.startHeartbeat(ws));
    ws.on('pong', () => (this.alive = true));
    ws.on('message', (data) => this.onFrame(parseFrame(data.toString())));
    ws.on('close', (code) => this.onClose(code));
    ws.on('error', (err) => this.emit('error', `Connection error: ${err.message}`));
  }

  /** Send an application body. `to` targets one peer; omit to broadcast. */
  send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // The sender id is sealed with the body so a tunnel in the middle can't re-attribute messages.
    const frame: MsgFrame = { t: 'msg', box: seal(this.opts.keys, { f: this.peerId, b: Body.parse(body) }), ...opts };
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  updateProfile(profile: Profile): void {
    this.profile = profile;
    if (this.ready) this.sendHello('');
  }

  /** The profile currently advertised to the room. */
  get currentProfile(): Profile {
    return this.profile;
  }

  get connected(): boolean {
    return this.ready;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.ws?.close();
  }

  /** Detect half-open connections (tunnels drop idle sockets silently). */
  private startHeartbeat(ws: WebSocket): void {
    clearInterval(this.heartbeat);
    this.alive = true;
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
  }

  private sendHello(nonce: string): void {
    const frame: Frame = {
      t: 'hello',
      peerId: this.peerId,
      proof: proveNonce(this.opts.keys, nonce, this.peerId),
      box: seal(this.opts.keys, this.profile),
    };
    this.ws?.send(JSON.stringify(frame));
  }

  private onFrame(frame: Frame | null): void {
    if (!frame) return;
    switch (frame.t) {
      case 'challenge':
        this.sendHello(frame.nonce);
        return;
      case 'welcome': {
        const payload = WelcomePayload.safeParse(open(this.opts.keys, frame.box));
        if (!payload.success) {
          this.emit('error', 'Could not decrypt room state (wrong secret?)');
          return;
        }
        this.ready = true;
        this.attempt = 0;
        this.emit('status', 'connected');
        this.emit('welcome', frame.you, payload.data.room);
        this.emit('peers', payload.data.peers);
        for (const msg of payload.data.history) this.deliver(msg);
        return;
      }
      case 'peers': {
        const peers = PeerInfoSchema.array().safeParse(open(this.opts.keys, frame.box));
        if (peers.success) this.emit('peers', peers.data);
        return;
      }
      case 'msg':
        this.deliver(frame);
        return;
      case 'error':
        this.emit('error', frame.message);
        return;
      default:
        return;
    }
  }

  private deliver(frame: MsgFrame): void {
    if (!frame.from) return;
    const id = `${frame.from}:${frame.box.iv}`;
    if (this.seen.has(id)) return; // history is replayed on every reconnect
    const sealed = SealedMessage.safeParse(open(this.opts.keys, frame.box));
    if (!sealed.success || sealed.data.f !== frame.from) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    this.emit('message', { id, from: frame.from, ts: frame.ts ?? Date.now(), body: sealed.data.b });
  }

  private onClose(code: number): void {
    this.ready = false;
    clearInterval(this.heartbeat);
    this.emit('status', 'disconnected');
    if (FATAL_CLOSE_CODES.has(code)) this.closed = true;
    if (this.closed || this.opts.reconnect === false) return;
    const delay = Math.min(15_000, 500 * 2 ** this.attempt++);
    this.timer = setTimeout(() => this.connect(), delay);
  }
}
