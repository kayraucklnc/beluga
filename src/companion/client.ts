/// <reference path="./modules.d.ts" />
/// <reference path="../net/mesh/modules.d.ts" />
import b4a from 'b4a';
import type DHT from 'hyperdht';
import { type DeviceKeys, type DeviceTicket, canonical, checkDevProof, devProof, deviceSecrets, fingerprint, hex, parseDeviceTicket, signKeyPair, verifyCert } from './device-crypto.js';
import {
  COMPANION_PIECE,
  COMPANION_PROTO,
  type DeviceCert,
  type DevicePair,
  KEEPALIVE_MS,
  type MacFrame,
  MAX_COMPANION_FRAME,
  MAX_UPLOAD_BYTES,
  type PhoneFrame,
  type Topic,
  compatible,
  parseDevicePair,
  parseMacFrame,
} from './protocol.js';

/**
 * The phone's side of the link, runtime-agnostic: it runs in Holepunch's Bare worklet on the
 * phone (react-native-bare-kit) and in Node for tests. So no Node builtins: only hyperdht (its
 * node is passed in), sodium-universal and b4a, and the shared, pure protocol.ts and
 * device-crypto.ts. Frames are the transport's (src/net/transport.ts): [u32 length][u8 kind][payload].
 *
 * - `pairDevice`: use a pairing (QR or code), wait for you to click Pair on the Mac, get the
 *   device certificate and the Mac's companion address.
 * - `CompanionClient`: dial the Mac with the device's link key, hello → welcome (or 4002: update),
 *   subscribe to what's on screen, call the API, fetch files by ref, keep alive while open.
 *   It reconnects only when asked (the app decides: foreground, a push, a retry button).
 */

type Bytes = Uint8Array;

/** What the client needs of a hyperdht node (the phone makes one when the app comes to the front). */
export type DhtNode = Pick<DHT, 'connect'>;

interface NoiseStream {
  readonly remotePublicKey: Bytes | null;
  readonly handshakeHash: Bytes | null;
  write(data: Bytes): boolean;
  end(): void;
  destroy(err?: Error): void;
  on(event: 'open' | 'connect' | 'end' | 'close', fn: () => void): unknown;
  on(event: 'data', fn: (data: Bytes) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

// ---- a tiny emitter (Bare has no node:events)

type Listener = (...args: unknown[]) => void;
class Emitter<E extends Record<string, unknown[]>> {
  private readonly listeners = new Map<keyof E, Set<Listener>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(fn as unknown as Listener);
    this.listeners.set(event, set);
    return () => void set.delete(fn as unknown as Listener);
  }
  protected emit<K extends keyof E>(event: K, ...args: E[K]): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...(args as unknown[]));
  }
}

// ---- frames on the Noise stream

const KIND = { text: 0, close: 1, ping: 2, pong: 3 } as const;

function frame(kind: number, payload: Bytes = b4a.alloc(0)): Bytes {
  const head = b4a.alloc(5);
  b4a.writeUInt32BE(head, payload.length + 1, 0);
  head[4] = kind;
  return b4a.concat([head, payload]);
}

interface FramedEvents extends Record<string, unknown[]> {
  open: [];
  text: [string];
  pong: [];
  close: [number, string];
}

/** Messages over the stream, as transport.ts frames them (close codes travel in a close frame). */
class Framed extends Emitter<FramedEvents> {
  private pending: Bytes = b4a.alloc(0);
  private code = 1006;
  private reason = '';
  private closing = false;
  private done = false;
  opened = false;

  constructor(
    readonly stream: NoiseStream,
    private readonly maxBytes: number,
  ) {
    super();
    stream.on('open', () => this.onOpen());
    stream.on('connect', () => this.onOpen());
    stream.on('data', (d) => this.onData(d));
    stream.on('end', () => stream.end());
    stream.on('error', () => undefined);
    stream.on('close', () => this.finish());
  }

  get isOpen(): boolean {
    return this.opened && !this.closing && !this.done;
  }

  send(text: string): void {
    if (this.isOpen) this.stream.write(frame(KIND.text, b4a.from(text, 'utf8')));
  }

  ping(): void {
    if (this.isOpen) this.stream.write(frame(KIND.ping));
  }

  close(code = 1000, reason = ''): void {
    if (this.closing || this.done) return;
    const r = b4a.from(reason, 'utf8');
    const payload = b4a.alloc(2 + r.length);
    payload[0] = (code >> 8) & 0xff;
    payload[1] = code & 0xff;
    payload.set(r, 2);
    if (this.opened) this.stream.write(frame(KIND.close, payload));
    this.closing = true;
    this.code = code;
    this.reason = reason;
    this.stream.end();
    const t = setTimeout(() => this.stream.destroy(), 2_000);
    (t as { unref?: () => void }).unref?.();
  }

  terminate(): void {
    this.closing = true;
    this.stream.destroy();
  }

  private onOpen(): void {
    if (this.opened || this.done) return;
    this.opened = true;
    this.emit('open');
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.emit('close', this.code, this.reason);
  }

  private onData(chunk: Bytes): void {
    if (this.done) return;
    this.pending = this.pending.length ? b4a.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 5 && !this.done) {
      const length = b4a.readUInt32BE(this.pending, 0);
      if (length < 1 || length - 1 > this.maxBytes) {
        this.pending = b4a.alloc(0);
        this.close(1009, 'too large');
        return;
      }
      if (this.pending.length < 4 + length) return;
      const kind = this.pending[4]!;
      const payload = this.pending.subarray(5, 4 + length);
      this.pending = this.pending.subarray(4 + length);
      if (kind === KIND.text && !this.closing) this.emit('text', b4a.toString(payload, 'utf8'));
      else if (kind === KIND.ping) this.stream.write(frame(KIND.pong));
      else if (kind === KIND.pong) this.emit('pong');
      else if (kind === KIND.close) {
        if (!this.closing) {
          this.code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1006;
          this.reason = payload.length > 2 ? b4a.toString(payload.subarray(2), 'utf8') : '';
        }
        this.closing = true;
        this.stream.end();
      }
    }
  }
}

const sameBytes = (a: Bytes | null | undefined, b: Bytes): boolean => Boolean(a) && a!.length === b.length && b4a.equals(a!, b);

// ---- pairing

/** The phone, as it introduces itself when pairing. */
export interface PhoneDevice {
  readonly keys: DeviceKeys;
  readonly name: string;
  readonly platform: 'android' | 'ios';
  /** The app's version ("1.0.0"). */
  readonly app: string;
}

export interface Paired {
  readonly cert: DeviceCert;
  /** The Mac's companion address (hex): where the phone dials from now on. */
  readonly address: string;
  readonly macName: string;
  /** The four pictures both screens showed. */
  readonly fingerprint: string;
}

const NOT_FOUND = 'Your Mac isn’t answering that pairing. Check the code, or start a new one on your Mac (they work for 10 minutes).';

/**
 * Pair with your Mac: find it by the pairing's secret (or code), prove we hold it, show the
 * fingerprint (`onWait`) while you click Pair on the Mac, and keep what it signs for us.
 */
export async function pairDevice(node: DhtNode, ticket: DeviceTicket | string, device: PhoneDevice, opts: { timeoutMs?: number; onWait?: (fingerprint: string) => void } = {}): Promise<Paired> {
  const parsed = typeof ticket === 'string' ? parseDeviceTicket(ticket) : ticket;
  if (!parsed) throw new Error('That isn’t a Beluga pairing code or link');
  const secrets = await deviceSecrets(parsed);
  const target = signKeyPair(secrets.seed).publicKey;
  const link = device.keys.link;
  const stream = node.connect(target as never, { keyPair: { publicKey: link.publicKey, secretKey: link.secretKey } as never }) as unknown as NoiseStream;
  const sock = new Framed(stream, 64 * 1024);
  return new Promise<Paired>((resolve, reject) => {
    let settled = false;
    let fp = '';
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      sock.close(1000);
    };
    // Long enough to find the Mac and for you to click Pair (the pairing itself lasts 10 minutes).
    const timer = setTimeout(() => settle(() => reject(new Error(fp ? 'Nobody clicked Pair on the Mac in time' : NOT_FOUND))), opts.timeoutMs ?? 10 * 60_000);
    const send = (msg: DevicePair): void => sock.send(JSON.stringify(msg));
    sock.on('open', () => {
      const hh = stream.handshakeHash;
      if (!hh || !sameBytes(stream.remotePublicKey, target)) return settle(() => reject(new Error(NOT_FOUND)));
      const hello = { t: 'dev_hello' as const, proto: COMPANION_PROTO.major, device: hex(device.keys.device.publicKey), box: hex(device.keys.box.publicKey), name: device.name.slice(0, 64), platform: device.platform, app: device.app.slice(0, 40) };
      send({ ...hello, mac: devProof(secrets.auth, 'phone', hh, canonical(hello)) });
    });
    sock.on('text', (text) => {
      const msg = parseDevicePair(text);
      const hh = stream.handshakeHash;
      if (!msg || !hh) return settle(() => reject(new Error('Your Mac answered something this app doesn’t understand: update it')));
      if (msg.t === 'dev_refused') return settle(() => reject(new Error(msg.reason)));
      if (msg.t === 'dev_wait') {
        fp = fingerprint(hh, link.publicKey, target);
        // The Mac shows the same four pictures: different ones mean someone is in the middle.
        if (msg.fingerprint !== fp) return settle(() => reject(new Error('The pairing’s fingerprint doesn’t match: try again')));
        opts.onWait?.(fp);
        return;
      }
      if (msg.t !== 'dev_ok') return settle(() => reject(new Error('Unexpected answer from your Mac')));
      const { mac, ...about } = msg;
      if (!checkDevProof(secrets.auth, 'mac', hh, canonical(about), mac)) return settle(() => reject(new Error('Your Mac couldn’t prove it made that pairing')));
      const c = msg.cert;
      if (!verifyCert(c) || c.link !== hex(link.publicKey) || c.device !== hex(device.keys.device.publicKey) || c.box !== hex(device.keys.box.publicKey)) {
        return settle(() => reject(new Error('The certificate from your Mac doesn’t check out')));
      }
      settle(() => resolve({ cert: c, address: msg.address, macName: msg.macName, fingerprint: fp }));
    });
    sock.on('close', () => settle(() => reject(new Error(fp ? 'The pairing was closed on your Mac' : NOT_FOUND))));
  });
}

// ---- the link

export interface Welcome {
  readonly mac: { readonly name: string; readonly version: string };
  readonly me: { readonly name: string; readonly peerId: string };
  readonly v: { readonly major: number; readonly minor: number };
}

export interface Chunk {
  readonly off: number;
  readonly bytes: Bytes;
  readonly eof: boolean;
  readonly size: number;
  readonly mime: string;
}

interface ClientEvents extends Record<string, unknown[]> {
  /** A finished view for a topic (replacing the last one). */
  view: [Topic, unknown, number];
  nudge: [Extract<MacFrame, { t: 'nudge' }>];
  /** The link closed: its code (4002: a version this Mac or app doesn't answer; 4010: this phone was removed) and why. */
  close: [number, string];
}

export interface CompanionClientOptions {
  readonly node: DhtNode;
  /** The Mac's companion address (hex, from pairing). */
  readonly address: string;
  /** The device's link key pair (the Mac's firewall knows its public key from the certificate). */
  readonly link: { readonly publicKey: Bytes; readonly secretKey: Bytes };
  readonly app: string;
  readonly platform: 'android' | 'ios';
  readonly topics?: readonly Topic[];
  readonly keepAliveMs?: number;
  readonly timeoutMs?: number;
}

/** One link to your Mac, open while you look. */
export class CompanionClient extends Emitter<ClientEvents> {
  welcome?: Welcome;
  private sock?: Framed;
  private nextId = 1;
  private topics: Topic[];
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; chunk?: (c: Chunk) => void }>();
  private beat?: ReturnType<typeof setInterval>;
  private heard = 0;

  constructor(private readonly opts: CompanionClientOptions) {
    super();
    this.topics = [...(opts.topics ?? ['home'])];
  }

  get connected(): boolean {
    return Boolean(this.sock?.isOpen && this.welcome);
  }

  /** Dial the Mac and say hello: resolves with its welcome, rejects when it can't be reached or turns us away. */
  connect(): Promise<Welcome> {
    this.close();
    const stream = this.opts.node.connect(b4a.from(this.opts.address, 'hex') as never, { keyPair: this.opts.link as never }) as unknown as NoiseStream;
    const sock = new Framed(stream, MAX_COMPANION_FRAME + 1024);
    this.sock = sock;
    this.welcome = undefined;
    return new Promise<Welcome>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Your Mac isn’t answering (asleep, or offline)'));
          sock.terminate();
        }
      }, this.opts.timeoutMs ?? 20_000);
      sock.on('open', () => {
        if (!sameBytes(stream.remotePublicKey, b4a.from(this.opts.address, 'hex'))) return sock.terminate();
        this.heard = Date.now();
        this.send({ t: 'hello', v: { ...COMPANION_PROTO }, app: this.opts.app.slice(0, 40), platform: this.opts.platform, topics: this.topics });
        const every = this.opts.keepAliveMs ?? KEEPALIVE_MS;
        this.beat = setInterval(() => {
          if (Date.now() - this.heard > every * 3) sock.terminate();
          else sock.ping();
        }, every);
      });
      sock.on('pong', () => (this.heard = Date.now()));
      sock.on('text', (text) => {
        this.heard = Date.now();
        const f = parseMacFrame(text);
        if (!f) return;
        if (f.t === 'welcome') {
          if (!compatible(COMPANION_PROTO, f.v, f.min)) {
            sock.close(4002, 'update');
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error(f.v.major > COMPANION_PROTO.major ? 'Update the Beluga app' : 'Update Beluga on your Mac'));
            }
            return;
          }
          this.welcome = { mac: f.mac, me: f.me, v: f.v };
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(this.welcome);
          }
          return;
        }
        this.onFrame(f);
      });
      sock.on('close', (code, reason) => {
        clearInterval(this.beat);
        for (const c of this.calls.values()) c.reject(new Error('The link to your Mac closed'));
        this.calls.clear();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(reason || (code === 1006 ? 'Your Mac isn’t answering (asleep, or offline)' : 'Your Mac closed the link')));
        }
        if (this.sock === sock) this.sock = undefined;
        this.emit('close', code, reason);
      });
    });
  }

  /** The topics on screen now (views for them arrive, and again when they change). */
  sub(topics: readonly Topic[]): void {
    this.topics = [...topics].slice(0, 16);
    if (this.welcome) this.send({ t: 'sub', topics: this.topics });
  }

  /** An API call (only `phone` methods get through; the rest are refused by the Mac). */
  call(method: string, args: readonly unknown[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not linked to your Mac'));
      this.calls.set(id, { resolve, reject });
      this.send({ t: 'call', id, method, args: [...args] });
    });
  }

  /** One piece of a file the Mac offered (`out:` ref): from `off`, as thumb, full or text. */
  get(ref: string, variant: 'thumb' | 'full' | 'text', off = 0): Promise<Chunk> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not linked to your Mac'));
      this.calls.set(id, { resolve: () => reject(new Error('No file came')), reject, chunk: resolve });
      this.send({ t: 'get', id, ref: ref as `out:${string}`, variant, off });
    });
  }

  /** A whole file (piece by piece; pictures are small, logs come in 192 KB pieces). */
  async getAll(ref: string, variant: 'thumb' | 'full' | 'text', max = 64 * 1024 * 1024): Promise<{ bytes: Bytes; mime: string; size: number }> {
    const parts: Bytes[] = [];
    let off = 0;
    for (;;) {
      const c = await this.get(ref, variant, off);
      parts.push(c.bytes);
      off += c.bytes.length;
      if (c.eof || !c.bytes.length || off >= max) return { bytes: b4a.concat(parts), mime: c.mime, size: c.size };
    }
  }

  /**
   * Send a photo or file to the Mac (in pieces) → its `up:` ref, for companion.ask / companion.post
   * (`files: [ref]`). Up to MAX_UPLOAD_BYTES.
   */
  async put(name: string, mime: string, bytes: Bytes): Promise<string> {
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('That file is too big to send (up to 25 MB)');
    const id = this.nextId++;
    for (let off = 0; ; off += COMPANION_PIECE) {
      const piece = bytes.subarray(off, off + COMPANION_PIECE);
      const eof = off + piece.length >= bytes.length;
      const value = (await new Promise<unknown>((resolve, reject) => {
        if (!this.connected) return reject(new Error('Not linked to your Mac'));
        this.calls.set(id, { resolve, reject });
        this.send({ t: 'put', id, name: name.slice(0, 200) || 'file', mime: mime.slice(0, 100), size: bytes.length, off, b64: b4a.toString(piece, 'base64'), eof });
      })) as { ref?: string } | undefined;
      if (eof) {
        if (!value?.ref) throw new Error('Your Mac didn’t take the file');
        return value.ref;
      }
    }
  }

  /** The app went to the background (the link closes after the grace) or came back. */
  focus(on: boolean): void {
    this.send({ t: 'focus', on });
  }

  /** Where to push to this phone while it's closed (Beluga Push). */
  registerPush(platform: 'fcm' | 'apns', token: string, relayKey: string): void {
    this.send({ t: 'push', platform, token, relayKey });
  }

  /** Say goodbye and close (the app went away). */
  bye(): void {
    this.send({ t: 'bye' });
    this.sock?.close(1000, 'bye');
  }

  /** Dial again (only when the app asks: coming to the front, a push, a retry). */
  reconnect(): Promise<Welcome> {
    return this.connect();
  }

  close(): void {
    clearInterval(this.beat);
    this.sock?.terminate();
    this.sock = undefined;
  }

  private send(f: PhoneFrame): void {
    this.sock?.send(JSON.stringify(f));
  }

  private onFrame(f: MacFrame): void {
    switch (f.t) {
      case 'view':
        return this.emit('view', f.topic, f.data, f.rev);
      case 'nudge':
        return this.emit('nudge', f);
      case 'result': {
        const c = this.calls.get(f.id);
        if (!c) return;
        this.calls.delete(f.id);
        if (f.ok) c.resolve(f.value);
        else c.reject(new Error(f.error ?? 'failed'));
        return;
      }
      case 'chunk': {
        const c = this.calls.get(f.id);
        if (!c?.chunk) return;
        this.calls.delete(f.id);
        c.chunk({ off: f.off, bytes: b4a.from(f.b64, 'base64'), eof: f.eof, size: f.size, mime: f.mime });
        return;
      }
      case 'bye':
        return;
      default:
        return;
    }
  }
}
