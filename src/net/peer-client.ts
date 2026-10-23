import { EventEmitter } from 'node:events';
import type DHT from 'hyperdht';
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
  PROTOCOL_VERSION,
  RekeyPayload,
  WelcomePayload,
  parseFrame,
} from '../protocol.js';
import { type Identity, type RoomKeys, deriveKeys, generateIdentity, open, proveNonce, seal, signBox, signNonce, verifyBox } from './crypto.js';
import { P2P_SCHEME } from './invite.js';
import { type P2POptions, createNode, dialP2P } from './p2p.js';
import { isLate, patientTimeout } from './patient-timer.js';
import { type MessageSocket, fromWebSocket } from './transport.js';

const SealedMessage = z.object({ f: z.string(), b: Body });
const HEARTBEAT_MS = 25_000;
const SEEN_LIMIT = 10_000;
const MAX_INCOMING = 4 * 1024 * 1024;
const HANDSHAKE_MS = 15_000;
const MAX_BACKOFF_MS = 15_000;

/** Hub rejections that retrying won't fix: bad secret, bad profile, room full. */
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4004, 4008, 4010]);

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** A dial failed; the next one is planned. */
export interface Retry {
  /** Failed dials in a row (1 for the first). */
  readonly attempt: number;
  /** When the next dial starts (ms since the epoch). */
  readonly retryAt: number;
  /** Why the last one failed, e.g. "Opening handshake has timed out". */
  readonly reason: string;
  /** The room answered and said why (a version mismatch, a refusal), rather than not being reached. */
  readonly said?: boolean;
}

export interface IncomingMessage {
  /** Unique per message (the AES-GCM IV), stable across history replays. */
  readonly id: string;
  readonly from: string;
  readonly ts: number;
  /** When the sender sent it (their clock, covered by their signature). */
  readonly sentAt: number;
  readonly body: Body;
}

interface ClientEvents {
  status: [ConnectionStatus];
  welcome: [PeerInfo, string | undefined];
  peers: [readonly PeerInfo[]];
  message: [IncomingMessage];
  /** Something the room told you (a refusal, a version mismatch). It's also the reason of the `retrying` or `ended` that follows. */
  error: [string];
  /** The connection is down and will be tried again; one per failed dial, for a status (never the chat log). */
  retrying: [Retry];
  /** The host replaced the invite; this is the new secret (for showing or re-sharing the link). */
  rekey: [string];
  /** The connection ended for good: removed by the host, room closed, or the invite stopped working. */
  ended: [string];
}

export interface PeerClientOptions {
  /** `ws://…` / `wss://…` (relay or LAN) or `p2p://<key>` (direct to the host). */
  readonly url: string;
  /** Tried when `url` can't be reached (e.g. hole-punching failed); whichever works is tried first next time. */
  readonly fallbackUrl?: string;
  /** Give up on a direct dial after this long and try the fallback. */
  readonly dialTimeoutMs?: number;
  /** DHT settings for direct dials (tests use a local testnet). */
  readonly p2p?: P2POptions;
  readonly keys: RoomKeys;
  readonly profile: Profile;
  /** Your signing key for this run (your peer id comes from it). Made fresh if omitted. */
  readonly identity?: Identity;
  readonly reconnect?: boolean;
}

/** One participant's connection to the room hub. Handles auth, E2E crypto and reconnects. */
export class PeerClient extends EventEmitter<ClientEvents> {
  readonly peerId: string;
  private socket?: MessageSocket;
  /** Where to dial, best first. */
  private targets: readonly string[];
  private node?: Promise<DHT>;
  private profile: Profile;
  private closed = false;
  private attempt = 0;
  private timer?: NodeJS.Timeout;
  private ready = false;
  private heartbeat?: NodeJS.Timeout;
  private alive = true;
  private readonly seen = new Set<string>();
  /** Proves you hold the invite (changes when the host replaces the invite). */
  private inviteKeys: RoomKeys;
  /** Seals every message (stays the same for the life of the room). */
  private roomKeys: RoomKeys;
  private lastError = '';
  /** Why the last dial or connection failed. */
  private failure = '';
  /** The room said why (see Retry.said). */
  private said = false;
  private readonly identity: Identity;

  constructor(private readonly opts: PeerClientOptions) {
    super();
    this.identity = opts.identity ?? generateIdentity();
    this.peerId = this.identity.peerId;
    this.profile = opts.profile;
    this.inviteKeys = opts.keys;
    this.roomKeys = opts.keys;
    this.targets = [opts.url, ...(opts.fallbackUrl && opts.fallbackUrl !== opts.url ? [opts.fallbackUrl] : [])];
  }

  connect(): void {
    this.closed = false;
    this.timer = undefined;
    this.emit('status', 'connecting');
    this.dial(0);
  }

  /** Where the current (or last) connection goes. */
  get via(): string | undefined {
    return this.targets[0];
  }

  private dial(index: number): void {
    this.failure = '';
    this.said = false;
    const url = this.targets[index] as string;
    if (!url.startsWith(P2P_SCHEME)) {
      // Our own handshake deadline, not ws's: it would fire after any long stall of this process.
      const socket = fromWebSocket(new WebSocket(url, { maxPayload: MAX_INCOMING }));
      const cancel = patientTimeout(HANDSHAKE_MS, () => {
        this.failure = 'Opening handshake has timed out';
        socket.terminate();
      });
      socket.once('open', cancel);
      socket.once('close', cancel);
      this.attach(socket, url, index);
      return;
    }
    const node = (this.node ??= createNode(this.opts.p2p));
    node.then(
      (dht) => {
        if (this.closed || dht.destroyed) return;
        this.attach(dialP2P(dht, url.slice(P2P_SCHEME.length), { maxBytes: MAX_INCOMING, timeoutMs: this.opts.dialTimeoutMs }), url, index);
      },
      (err: Error) => {
        // Direct connections are unavailable here (the native modules didn't load).
        this.node = undefined;
        if (index + 1 < this.targets.length) this.dial(index + 1);
        else {
          this.failure = `Direct connections are unavailable: ${err.message}`;
          this.onClose(1006);
        }
      },
    );
  }

  private attach(socket: MessageSocket, url: string, index: number): void {
    const hasNext = index + 1 < this.targets.length;
    let opened = false;
    this.socket = socket;
    socket.on('open', () => {
      opened = true;
      // Remember what worked so reconnects try it first.
      this.targets = [url, ...this.targets.filter((t) => t !== url)];
      this.startHeartbeat(socket);
    });
    socket.on('pong', () => (this.alive = true));
    socket.on('message', (data) => this.onFrame(parseFrame(data)));
    socket.on('close', (code) => {
      if (!opened && hasNext && !this.closed) this.dial(index + 1);
      else this.onClose(code);
    });
    socket.on('error', (err) => {
      // A failed direct dial isn't worth reporting when there's still the relay to try. When our
      // handshake deadline cut it, that already said why (ws then adds "closed before…").
      if ((opened || !hasNext) && !err.message.startsWith('WebSocket was closed before')) this.failure = err.message;
    });
  }

  /** Send an application body. `to` targets one peer; omit to broadcast. */
  send(body: BodyInput, opts: { to?: string; keep?: boolean } = {}): boolean {
    if (!this.ready || !this.socket?.isOpen) return false;
    // The sender id is sealed with the body so a tunnel in the middle can't re-attribute messages,
    // and signed with your own key so nobody else in the room (not even the host) can forge it.
    const box = seal(this.roomKeys, { f: this.peerId, b: Body.parse(body) });
    const sts = Date.now();
    const frame: MsgFrame = { t: 'msg', box, ...opts, pub: this.identity.publicKey, sig: signBox(this.identity, box, `${opts.to ?? ''}|${sts}`), sts };
    this.socket.send(JSON.stringify(frame));
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

  /** Waiting to dial again: dial now instead (the "Retry now" button). */
  retryNow(): boolean {
    if (this.closed || this.ready || !this.timer) return false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.connect();
    return true;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.socket?.close();
    const node = this.node;
    this.node = undefined;
    void node?.then((dht) => dht.destroy({ force: true })).catch(() => undefined);
  }

  /** Detect half-open connections (tunnels drop idle sockets silently). */
  private startHeartbeat(ws: MessageSocket): void {
    clearInterval(this.heartbeat);
    this.alive = true;
    let last = Date.now();
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      // Stalled or asleep: the pong may be waiting to be read, so ask again instead of hanging up.
      const late = isLate(now - last, HEARTBEAT_MS);
      last = now;
      if (!this.alive && !late) {
        this.failure = 'The room stopped answering';
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
  }

  private sendHello(nonce: string): void {
    // Joining proves the invite and seals with its key; later profile updates use the room key.
    const frame: Frame = {
      t: 'hello',
      peerId: this.peerId,
      proof: proveNonce(this.inviteKeys, nonce, this.peerId),
      pub: this.identity.publicKey,
      sig: signNonce(this.identity, nonce),
      box: seal(this.ready ? this.roomKeys : this.inviteKeys, this.profile),
    };
    this.socket?.send(JSON.stringify(frame));
  }

  private onFrame(frame: Frame | null): void {
    if (!frame) return;
    switch (frame.t) {
      case 'challenge':
        if (frame.v !== PROTOCOL_VERSION) {
          // Hang up now (not at the room's auth timeout): the retry says why, and tries again later.
          this.refused(frame.v > PROTOCOL_VERSION ? 'The host has a newer klaud. Run klaud update, then join again' : 'The host has an older klaud. Ask them to run klaud update');
          this.socket?.close();
          return;
        }
        this.sendHello(frame.nonce);
        return;
      case 'welcome': {
        const payload = WelcomePayload.safeParse(open(this.inviteKeys, frame.box));
        if (!payload.success) {
          this.refused('Could not decrypt room state (wrong secret?)');
          this.socket?.close();
          return;
        }
        this.roomKeys = payload.data.roomKey ? { enc: Buffer.from(payload.data.roomKey, 'base64'), auth: this.inviteKeys.auth } : this.inviteKeys;
        // You were away when the host replaced the invite: take the current one.
        if (payload.data.secret) {
          this.inviteKeys = deriveKeys(payload.data.secret);
          this.emit('rekey', payload.data.secret);
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
        const peers = PeerInfoSchema.array().safeParse(open(this.roomKeys, frame.box));
        if (peers.success) this.emit('peers', peers.data);
        return;
      }
      case 'rekey': {
        const next = RekeyPayload.safeParse(open(this.roomKeys, frame.box));
        if (!next.success) return;
        this.inviteKeys = deriveKeys(next.data.secret);
        this.emit('rekey', next.data.secret);
        return;
      }
      case 'msg':
        this.deliver(frame);
        return;
      case 'error':
        this.lastError = frame.message;
        this.refused(frame.message);
        return;
      default:
        return;
    }
  }

  /** The room said why it won't have you (for now): the reason of the retry (or end) that follows. */
  private refused(message: string): void {
    this.failure = message;
    this.said = true;
    this.emit('error', message);
  }

  private deliver(frame: MsgFrame): void {
    if (!frame.from) return;
    const id = `${frame.from}:${frame.box.iv}`;
    if (this.seen.has(id)) return; // history is replayed on every reconnect
    // Unsigned, or signed by someone else's key: not from who it claims to be.
    if (!frame.pub || !frame.sig || frame.sts === undefined || !verifyBox(frame.pub, frame.from, frame.box, frame.sig, `${frame.to ?? ''}|${frame.sts}`)) return;
    const sealed = SealedMessage.safeParse(open(this.roomKeys, frame.box));
    if (!sealed.success || sealed.data.f !== frame.from) return;
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    this.emit('message', { id, from: frame.from, ts: frame.ts ?? Date.now(), sentAt: frame.sts, body: sealed.data.b });
  }

  private onClose(code: number): void {
    this.ready = false;
    clearInterval(this.heartbeat);
    this.emit('status', 'disconnected');
    if (FATAL_CLOSE_CODES.has(code)) {
      this.closed = true;
      this.emit('ended', this.lastError || 'The connection was closed');
    }
    if (this.closed || this.opts.reconnect === false) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++);
    this.timer = setTimeout(() => this.connect(), delay);
    this.emit('retrying', { attempt: this.attempt, retryAt: Date.now() + delay, reason: this.failure || 'The connection dropped', ...(this.said ? { said: true } : {}) });
  }
}
