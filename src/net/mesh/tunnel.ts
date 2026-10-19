import type NoiseSecretStream from '@hyperswarm/secret-stream';
import type { KeyPair } from 'hyperdht';
import { type MessageSocket, fromStream } from '../transport.js';
import type { MeshLink } from './link.js';
import type { LinkMessage } from './wire.js';

/**
 * Relaying through another member's Mac, for when two Macs can't reach each other directly
 * (both behind strict NATs, say). Alice asks Bob, whom both are linked to, to open a tunnel
 * to Carol; Bob passes bytes along. Inside the tunnel Alice and Carol run their own Noise
 * handshake with their network keys, so Bob only ever sees ciphertext and can't pose as either.
 * (Bob does learn that the two of them talk, and how much.)
 */

/** Tunnels one Mac relays at once, in total and per link. */
const MAX_ROUTES = 64;
const MAX_ROUTES_PER_PEER = 16;
/** A relayed tunnel nothing went through for this long is dropped (links inside send heartbeats). */
const ROUTE_IDLE_MS = 5 * 60 * 1000;
/** Tunnels ending here through one relay at once. */
const MAX_ENDS_PER_PEER = 16;
/** Bytes per tunnel frame before base64 (frames stay well under the link's size limit). */
const CHUNK = 48 * 1024;

interface Route {
  readonly peer: string;
  readonly tid: number;
  /** This Mac picked `tid` on that hop. */
  readonly mine: boolean;
}

interface End {
  readonly via: string;
  readonly tid: number;
  readonly mine: boolean;
  readonly stream: InstanceType<typeof NoiseSecretStream>;
}

export interface TunnelOptions {
  /** The Noise stream class (loaded lazily with the rest of the native networking code). */
  readonly NoiseStream: typeof NoiseSecretStream;
  readonly keyPair: KeyPair;
  /** Pass tunnels along for others. */
  readonly relay: boolean;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly linkOf: (peerId: string) => MeshLink | undefined;
  readonly addressOf: (peerId: string) => string | undefined;
  /** Hand a working tunnel to the link manager; false when it isn't wanted (e.g. a better link exists). */
  readonly adopt: (socket: MessageSocket, peerId: string, outgoing: boolean) => boolean;
}

const keyOf = (peer: string, tid: number, mine: boolean): string => `${peer}:${tid}:${mine ? 1 : 0}`;

export class Tunnels {
  private readonly routes = new Map<string, Route>();
  private readonly ends = new Map<string, End>();
  /** When something last went through each relayed route (by route key). */
  private readonly used = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;
  private next = 1;

  constructor(private readonly opts: TunnelOptions) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(ROUTE_IDLE_MS, 60_000));
    this.sweeper.unref();
  }

  /** Handle a tunnel message from a link; false when it isn't one. */
  handle(from: MeshLink, msg: LinkMessage): boolean {
    switch (msg.t) {
      case 'tun_open':
        this.relayOpen(from, msg.tid, msg.to);
        return true;
      case 'tun_in':
        this.accept(from, msg.tid, msg.from);
        return true;
      case 'tun_data':
      case 'tun_close': {
        const key = keyOf(from.peerId, msg.tid, !msg.o);
        const end = this.ends.get(key);
        if (end) {
          if (msg.t === 'tun_data') end.stream.rawStream.write(Buffer.from(msg.d, 'base64'));
          else end.stream.destroy();
          return true;
        }
        const route = this.routes.get(key);
        if (!route) return true;
        this.used.set(key, Date.now());
        const onward = this.opts.linkOf(route.peer);
        if (msg.t === 'tun_close' || !onward) this.dropRoute(from.peerId, msg.tid, !msg.o);
        onward?.send(msg.t === 'tun_data' ? { t: 'tun_data', tid: route.tid, o: route.mine, d: msg.d } : { t: 'tun_close', tid: route.tid, o: route.mine });
        if (!onward) from.send({ t: 'tun_close', tid: msg.tid, o: msg.o ? false : true, reason: 'gone' });
        return true;
      }
      default:
        return false;
    }
  }

  /** Try to reach `target` through each of `via` in turn; true once a tunnel is up and adopted. */
  async open(target: string, via: readonly string[]): Promise<boolean> {
    const address = this.opts.addressOf(target);
    if (!address) return false;
    for (const peer of via) {
      const link = this.opts.linkOf(peer);
      if (link && peer !== target && (await this.tryVia(link, target, address))) return true;
    }
    return false;
  }

  /** A link closed: everything going through it ends. */
  dropPeer(peerId: string): void {
    for (const [key, end] of [...this.ends]) if (end.via === peerId) this.ends.delete(key) && end.stream.destroy();
    for (const [key, route] of [...this.routes]) {
      if (key.startsWith(`${peerId}:`)) {
        this.routes.delete(key);
        this.routes.delete(keyOf(route.peer, route.tid, route.mine));
        this.opts.linkOf(route.peer)?.send({ t: 'tun_close', tid: route.tid, o: route.mine, reason: 'gone' });
      }
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const end of this.ends.values()) end.stream.destroy();
    this.ends.clear();
    this.routes.clear();
  }

  private tryVia(link: MeshLink, target: string, address: string): Promise<boolean> {
    const tid = this.next++;
    const stream = new this.opts.NoiseStream(true, null, { keyPair: this.opts.keyPair, remotePublicKey: Buffer.from(address, 'hex') });
    this.attach({ via: link.peerId, tid, mine: true, stream });
    link.send({ t: 'tun_open', tid, to: target });
    return this.settle(stream, target, true);
  }

  /** Someone asks to reach you through `from`. */
  private accept(from: MeshLink, tid: number, peer: string): void {
    const address = this.opts.addressOf(peer);
    const through = [...this.ends.values()].filter((e) => e.via === from.peerId).length;
    if (!address || through >= MAX_ENDS_PER_PEER || this.ends.has(keyOf(from.peerId, tid, false))) {
      from.send({ t: 'tun_close', tid, o: false, reason: address ? 'busy' : 'unknown' });
      return;
    }
    const stream = new this.opts.NoiseStream(false, null, { keyPair: this.opts.keyPair });
    this.attach({ via: from.peerId, tid, mine: false, stream });
    void this.settle(stream, peer, false);
  }

  /** Wait for the inner handshake; it must be the person we expect, end to end. */
  private settle(stream: End['stream'], peer: string, outgoing: boolean): Promise<boolean> {
    const socket = fromStream(stream, { maxBytes: this.opts.maxBytes });
    return new Promise((resolve) => {
      const timer = setTimeout(() => socket.terminate(), this.opts.timeoutMs);
      timer.unref();
      socket.once('open', () => {
        clearTimeout(timer);
        const ok = stream.remotePublicKey?.toString('hex') === this.opts.addressOf(peer) && this.opts.adopt(socket, peer, outgoing);
        if (!ok) socket.terminate();
        resolve(ok);
      });
      socket.once('close', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private attach(end: End): void {
    const key = keyOf(end.via, end.tid, end.mine);
    this.ends.set(key, end);
    end.stream.rawStream.on('data', (chunk: Buffer) => {
      const link = this.opts.linkOf(end.via);
      for (let i = 0; i < chunk.length; i += CHUNK) link?.send({ t: 'tun_data', tid: end.tid, o: end.mine, d: chunk.subarray(i, i + CHUNK).toString('base64') });
    });
    end.stream.rawStream.on('error', () => undefined);
    end.stream.on('error', () => undefined);
    end.stream.on('close', () => {
      if (this.ends.get(key) !== end) return;
      this.ends.delete(key);
      this.opts.linkOf(end.via)?.send({ t: 'tun_close', tid: end.tid, o: end.mine });
    });
  }

  /** Relay: `from` wants to reach `to` through this Mac. */
  private relayOpen(from: MeshLink, tid: number, to: string): void {
    const onward = this.opts.linkOf(to);
    const refuse = (reason: string): void => from.send({ t: 'tun_close', tid, o: false, reason });
    if (!this.opts.relay) return refuse('not relaying');
    if (!onward || to === from.peerId) return refuse('not linked');
    if (this.routes.has(keyOf(from.peerId, tid, false))) return refuse('already open');
    const mineFrom = [...this.routes.keys()].filter((k) => k.startsWith(`${from.peerId}:`)).length;
    if (this.routes.size / 2 >= MAX_ROUTES || mineFrom >= MAX_ROUTES_PER_PEER) return refuse('busy');
    const rid = this.next++;
    this.routes.set(keyOf(from.peerId, tid, false), { peer: to, tid: rid, mine: true });
    this.routes.set(keyOf(to, rid, true), { peer: from.peerId, tid, mine: false });
    this.used.set(keyOf(from.peerId, tid, false), Date.now());
    onward.send({ t: 'tun_in', tid: rid, from: from.peerId });
  }

  private dropRoute(peer: string, tid: number, mine: boolean): void {
    const key = keyOf(peer, tid, mine);
    const route = this.routes.get(key);
    this.routes.delete(key);
    this.used.delete(key);
    if (route) {
      this.routes.delete(keyOf(route.peer, route.tid, route.mine));
      this.used.delete(keyOf(route.peer, route.tid, route.mine));
    }
  }

  /** Drop relayed routes nothing went through lately (both ends are told). */
  private sweep(): void {
    const now = Date.now();
    for (const [key, route] of [...this.routes]) {
      const back = keyOf(route.peer, route.tid, route.mine);
      if (now - Math.max(this.used.get(key) ?? 0, this.used.get(back) ?? 0) < ROUTE_IDLE_MS) continue;
      const [peer = '', tid = '0', mine = '0'] = key.split(':');
      this.dropRoute(peer, Number(tid), mine === '1');
      this.opts.linkOf(peer)?.send({ t: 'tun_close', tid: Number(tid), o: mine === '1', reason: 'idle' });
      this.opts.linkOf(route.peer)?.send({ t: 'tun_close', tid: route.tid, o: route.mine, reason: 'idle' });
    }
  }
}
