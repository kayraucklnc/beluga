/// <reference path="../net/mesh/modules.d.ts" />
import { randomBytes, randomInt } from 'node:crypto';
import type DHT from 'hyperdht';
import type { NoiseSocket, Server } from 'hyperdht';
import type { Identity } from '../net/crypto.js';
import { signText } from '../net/mesh/keys.js';
import { type MessageSocket, fromStream } from '../net/transport.js';
import { CERT_LABEL, CODE_ALPHABET, CODE_LENGTH, type DeviceTicket, PAIR_TTL_MS, canonical, checkDevProof, devProof, deviceLink, deviceSecrets, fingerprint, formatCode, signKeyPair } from './device-crypto.js';
import { type DeviceBook, deviceId } from './devices.js';
import { COMPANION_PROTO, type DeviceCert, type DevicePair, parseDevicePair } from './protocol.js';

/**
 * The Mac's side of pairing a phone (docs/companion.md, "Signing in"). Pair a Phone opens a
 * one-time pairing: a 128-bit secret (the QR, `beluga://device#…`) and a 12-character code, both
 * good for 10 minutes and one phone. Each turns into a temporary key pair the Mac listens on
 * (device-crypto.ts), so only someone holding it can even find the Mac. Then, over that Noise
 * connection:
 *   phone → dev_hello {device, box, name, platform, mac}   mac = proof(secret, "phone", handshake, hello)
 *   Mac   → dev_wait {fingerprint}                          you see "Pair Kayra's Pixel 9?" and 4 pictures
 *   (you click Pair: companion.pair.approve)
 *   Mac   → dev_ok {cert, address, macName, mac}            or dev_refused {reason}
 * The certificate binds the phone's keys (its link key is the one it dialed with) to your
 * identity; the proofs bind both sides to this connection, so nobody can sit in the middle.
 */

const MAX_PAIR_BYTES = 64 * 1024;
/** Wrong proofs a pairing takes per minute before it refuses everyone for the rest of it. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

export interface PairingInfo {
  readonly link: string;
  readonly code: string;
  readonly expiresAt: number;
  readonly waiting?: { readonly name: string; readonly fingerprint: string };
}

export interface DevicePairingOptions {
  /** The DHT node to listen on (the companion host's). */
  readonly node: () => Promise<DHT>;
  readonly identity: Identity;
  readonly devices: DeviceBook;
  /** The Mac's companion address (hex) and name, for the phone to keep. */
  readonly address: () => string;
  readonly macName: () => string;
  /** The pairing opened, a phone is waiting, or it closed. */
  readonly onChange: () => void;
  /** A phone was paired (its device id). */
  readonly onPaired?: (id: string) => void;
  readonly ttlMs?: number;
}

interface Waiting {
  readonly socket: MessageSocket;
  readonly hello: Extract<DevicePair, { t: 'dev_hello' }>;
  readonly link: string;
  readonly hh: Buffer;
  readonly auth: Uint8Array;
  readonly fingerprint: string;
}

interface Open {
  readonly secret: string;
  readonly code: string;
  readonly expiresAt: number;
  readonly servers: Server[];
  readonly timer: NodeJS.Timeout;
  failures: number[];
  waiting?: Waiting;
}

const send = (socket: MessageSocket, msg: DevicePair): void => socket.send(JSON.stringify(msg));

export class DevicePairing {
  private open?: Open;

  constructor(private readonly opts: DevicePairingOptions) {}

  /** The pairing open now, as the Mac's screens show it (the shared state's `companion.pairing`). */
  info(): PairingInfo | undefined {
    const o = this.open;
    if (!o) return undefined;
    return { link: deviceLink(o.secret), code: formatCode(o.code), expiresAt: o.expiresAt, ...(o.waiting ? { waiting: { name: o.waiting.hello.name, fingerprint: o.waiting.fingerprint } } : {}) };
  }

  get isOpen(): boolean {
    return this.open !== undefined;
  }

  /** Open a new pairing (one at a time: an open one is closed first). */
  async start(): Promise<PairingInfo> {
    await this.cancel();
    const secret = randomBytes(16).toString('base64url');
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = Date.now() + (this.opts.ttlMs ?? PAIR_TTL_MS);
    const node = await this.opts.node();
    const servers: Server[] = [];
    const tickets: DeviceTicket[] = [
      { via: 'link', secret },
      { via: 'code', code },
    ];
    const timer = setTimeout(() => void this.cancel(), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    const open: Open = { secret, code, expiresAt, servers, timer, failures: [] };
    this.open = open;
    try {
      for (const ticket of tickets) {
        const secrets = await deviceSecrets(ticket);
        const keyPair = signKeyPair(secrets.seed);
        const server = node.createServer({}, (stream: NoiseSocket) => this.serve(open, secrets.auth, Buffer.from(keyPair.publicKey), stream));
        servers.push(server);
        await server.listen({ publicKey: Buffer.from(keyPair.publicKey), secretKey: Buffer.from(keyPair.secretKey) });
      }
    } catch (err) {
      if (this.open === open) await this.cancel();
      throw err;
    }
    this.opts.onChange();
    return this.info()!;
  }

  /** You said Pair to the phone that's waiting. */
  approve(): string {
    const o = this.open;
    const w = o?.waiting;
    if (!o || !w) throw new Error('No phone is waiting to be paired');
    const { identity } = this.opts;
    const unsigned: Omit<DeviceCert, 'sig'> = {
      v: 1,
      owner: identity.peerId,
      ownerKey: identity.publicKey,
      device: w.hello.device,
      link: w.link,
      box: w.hello.box,
      name: w.hello.name,
      platform: w.hello.platform,
      issuedAt: Date.now(),
    };
    const cert: DeviceCert = { ...unsigned, sig: signText(identity, CERT_LABEL, canonical(unsigned)) };
    try {
      this.opts.devices.add(cert, w.hello.app);
    } catch (err) {
      send(w.socket, { t: 'dev_refused', reason: err instanceof Error ? err.message.slice(0, 200) : 'Could not pair' });
      w.socket.close(1000);
      throw err;
    }
    const ok = { t: 'dev_ok' as const, cert, address: this.opts.address(), macName: this.opts.macName().slice(0, 100) };
    send(w.socket, { ...ok, mac: devProof(w.auth, 'mac', w.hh, canonical(ok)) });
    w.socket.close(1000);
    o.waiting = undefined;
    const id = deviceId(cert);
    void this.cancel();
    this.opts.onPaired?.(id);
    return id;
  }

  /** Close the pairing (a waiting phone hears no). */
  async cancel(reason = 'The pairing was closed on the Mac'): Promise<void> {
    const o = this.open;
    if (!o) return;
    this.open = undefined;
    clearTimeout(o.timer);
    if (o.waiting) {
      send(o.waiting.socket, { t: 'dev_refused', reason });
      o.waiting.socket.close(1000);
    }
    this.opts.onChange();
    await Promise.all(o.servers.map((s) => s.close().catch(() => undefined)));
  }

  private serve(open: Open, auth: Uint8Array, pairingKey: Buffer, stream: NoiseSocket): void {
    const socket = fromStream(stream, { maxBytes: MAX_PAIR_BYTES, open: true });
    socket.on('error', () => undefined);
    const refuse = (reason: string): void => {
      send(socket, { t: 'dev_refused', reason });
      socket.close(1000);
    };
    // The phone has until the pairing ends: it waits for you to click Pair.
    const timer = setTimeout(() => socket.terminate(), Math.max(1000, open.expiresAt - Date.now()));
    timer.unref();
    socket.once('close', () => {
      clearTimeout(timer);
      if (open.waiting?.socket === socket) {
        open.waiting = undefined;
        if (this.open === open) this.opts.onChange();
      }
    });
    socket.once('message', (text) => {
      if (this.open !== open) return refuse('That pairing has closed; open a new one on your Mac');
      const msg = parseDevicePair(text);
      const hh = stream.handshakeHash;
      const recent = open.failures.filter((t) => Date.now() - t < FAILURE_WINDOW_MS);
      if (recent.length >= MAX_FAILURES) return refuse('Too many tries; open a new pairing on your Mac');
      if (msg?.t !== 'dev_hello' || !hh) {
        open.failures = [...recent, Date.now()];
        return refuse("That pairing couldn't be verified");
      }
      const { mac, ...about } = msg;
      if (!checkDevProof(auth, 'phone', hh, canonical(about), mac)) {
        open.failures = [...recent, Date.now()];
        return refuse("That pairing couldn't be verified");
      }
      if (msg.proto !== COMPANION_PROTO.major) return refuse(msg.proto > COMPANION_PROTO.major ? 'Update Beluga on your Mac to pair this phone' : 'Update the Beluga app to pair with this Mac');
      if (open.waiting) return refuse('Another phone is pairing right now; try again in a moment');
      const link = stream.remotePublicKey.toString('hex');
      open.waiting = { socket, hello: msg, link, hh, auth, fingerprint: fingerprint(hh, stream.remotePublicKey, pairingKey) };
      send(socket, { t: 'dev_wait', fingerprint: open.waiting.fingerprint });
      this.opts.onChange();
    });
  }
}
