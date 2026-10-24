/// <reference path="./modules.d.ts" />
/// <reference path="../net/mesh/modules.d.ts" />
import SecretStream from '@hyperswarm/secret-stream';
import b4a from 'b4a';
import type DHT from 'hyperdht';
import { Duplex } from 'streamx';
import { type DialAttempt, type LinkPath, RelayRecord, relayUrlFor } from './protocol.js';

/**
 * Reaching the Mac on any network (docs/companion.md, "Any network"), for the phone and for
 * tests. Runtime-agnostic like client.ts: hyperdht, secret-stream, streamx and b4a only.
 *
 * Two ways, raced with staggered starts rather than one after the other:
 *  - `p2p`: hyperdht's dial. It tries the Mac's LAN address first when both are behind the same
 *    public IP, then hole-punches; the result is `lan` or `direct`.
 *  - `relay`: a WebSocket to the Mac's Cloudflare tunnel, with the same Noise handshake inside
 *    (secret-stream over the socket), so both keys stay pinned and the relay sees ciphertext only.
 *    Its URL comes from a hint (the pairing link, the last welcome) or from the Mac's signed record
 *    on the DHT, which a network that blocks peer connections usually still answers.
 * The path that worked last time on this network starts first; the others follow after a moment.
 */

type Bytes = Uint8Array;

/** An open, Noise-encrypted stream to the Mac (hyperdht's, or secret-stream over the relay). */
export interface NoiseStream {
  readonly remotePublicKey: Bytes | null;
  readonly handshakeHash: Bytes | null;
  readonly rawStream?: { readonly remoteHost?: string } | null;
  write(data: Bytes): boolean;
  end(): void;
  destroy(err?: Error): void;
  on(event: 'open' | 'connect' | 'end' | 'close', fn: () => void): unknown;
  on(event: 'data', fn: (data: Bytes) => void): unknown;
  on(event: 'error', fn: (err: Error & { code?: string }) => void): unknown;
}

/** A WebSocket, however the runtime makes one (Node's `ws`, the phone app's native WebSocket via IPC). */
export interface MessagePipe {
  send(data: Bytes): void;
  close(): void;
  onOpen(fn: () => void): void;
  onMessage(fn: (data: Bytes) => void): void;
  /** `code`: the WebSocket close code, or an HTTP status when it never opened (404: nothing there). */
  onClose(fn: (code?: number) => void): void;
}
export type OpenRelay = (url: string) => MessagePipe;

/** A WebSocket as the raw stream secret-stream runs over: each binary message is a chunk. */
export function pipeDuplex(pipe: MessagePipe): Duplex & { closeCode?: number } {
  let opened = false;
  let openCb: ((err?: Error | null) => void) | undefined;
  const d: Duplex & { closeCode?: number } = new Duplex({
    open(cb) {
      if (opened) cb(null);
      else openCb = cb;
    },
    write(data, cb) {
      pipe.send(data);
      cb(null);
    },
    final(cb) {
      pipe.close();
      cb(null);
    },
    destroy(cb) {
      pipe.close();
      cb(null);
    },
  });
  pipe.onOpen(() => {
    opened = true;
    const cb = openCb;
    openCb = undefined;
    cb?.(null);
  });
  pipe.onMessage((data) => d.push(data));
  pipe.onClose((code) => {
    d.closeCode = code;
    if (!opened && openCb) {
      const cb = openCb;
      openCb = undefined;
      cb(new Error(`relay closed (${code ?? 'no code'})`));
    }
    // End, so what came before the close (the Mac's last frame) is still read; then let it go.
    d.push(null);
    const t = setTimeout(() => d.destroy(), opened ? 2_000 : 0);
    (t as { unref?: () => void }).unref?.();
  });
  return d;
}

const NoiseOver = SecretStream as unknown as new (isInitiator: boolean, raw: unknown, opts: { keyPair: { publicKey: Bytes; secretKey: Bytes }; remotePublicKey?: Bytes }) => NoiseStream & { readonly opened: Promise<boolean> };

/** Secret-stream over a relay socket, as the initiator: the same Noise handshake as hyperdht's. */
export function noiseOverRelay(pipe: MessagePipe, keyPair: { publicKey: Bytes; secretKey: Bytes }, remotePublicKey: Bytes): NoiseStream & { readonly opened: Promise<boolean>; readonly raw: Duplex & { closeCode?: number } } {
  const raw = pipeDuplex(pipe);
  const s = new NoiseOver(true, raw, { keyPair, remotePublicKey });
  return Object.assign(s, { raw });
}

/** The same, as the responder (the Mac's end of the relay), holding the key the phone dialed. */
export function noiseResponder(pipe: MessagePipe, keyPair: { publicKey: Bytes; secretKey: Bytes }): NoiseStream & { readonly opened: Promise<boolean>; readonly raw: Duplex & { closeCode?: number } } {
  const raw = pipeDuplex(pipe);
  const s = new NoiseOver(false, raw, { keyPair });
  return Object.assign(s, { raw });
}

/** The Mac's relay from its signed record on the DHT (its key, or an open pairing's), if it has one. */
export async function lookupRelay(node: Partial<Pick<DHT, 'mutableGet'>> | undefined, key: Bytes, timeoutMs = 6_000): Promise<{ relay?: string; at?: number; found: boolean }> {
  if (!node?.mutableGet) return { found: false };
  try {
    const got = await Promise.race([node.mutableGet(b4a.from(key) as never, { latest: true }), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    if (!got) return { found: false };
    const rec = RelayRecord.safeParse(JSON.parse(b4a.toString(got.value as Bytes, 'utf8')));
    return rec.success ? { found: true, at: rec.data.at, ...(rec.data.relay ? { relay: rec.data.relay } : {}) } : { found: false };
  } catch {
    return { found: false };
  }
}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|fc|fd|fe80:)/i;

export interface DialOptions {
  readonly node?: Pick<DHT, 'connect'> & Partial<Pick<DHT, 'mutableGet'>>;
  /** Who we dial: the Mac's companion key, or a pairing's temporary key. */
  readonly target: Bytes;
  readonly keyPair: { readonly publicKey: Bytes; readonly secretKey: Bytes };
  /** Relay URLs already known (a pairing link's, the last welcome's), best first. */
  readonly relays?: readonly string[];
  /** Opens WebSockets; without it, no relay. */
  readonly openRelay?: OpenRelay;
  /** The way that worked last time on this network: it starts first. */
  readonly prefer?: 'p2p' | 'relay';
  /** How long the second way waits before it starts too (unless the first fails sooner). */
  readonly staggerMs?: number;
  readonly timeoutMs?: number;
  /** Tests: never dial hyperdht. */
  readonly noP2p?: boolean;
  /** Whether the DHT itself can be reached (dhtHealth), asked when nothing worked. */
  readonly probeDht?: () => DialReport['dht'];
}

/** Can this node reach the DHT at all: it bootstrapped and knows other nodes (UDP blocked: it knows none). */
export function dhtHealth(node: unknown): DialReport['dht'] {
  const n = node as { bootstrapped?: boolean; table?: { toArray?: () => unknown[] } } | undefined;
  if (!n?.bootstrapped) return 'unknown';
  const size = n.table?.toArray?.().length;
  return size === undefined ? 'unknown' : size > 0 ? 'ok' : 'unreachable';
}

export interface Dialed {
  readonly stream: NoiseStream;
  readonly path: LinkPath;
  readonly tried: DialAttempt[];
  /** The relay that worked, or the one the DHT says the Mac has now. */
  readonly relay?: string;
}

/** Why nothing worked: every attempt, what the DHT said, and whether the Mac seems to exist. */
export interface DialReport {
  readonly tried: DialAttempt[];
  /** The DHT answered at all (it did when a record or a peer lookup came back). */
  readonly dht: 'ok' | 'unreachable' | 'unknown';
  /** The Mac (or the pairing) was found: it answered on the DHT, has a fresh relay record, or refused us. */
  readonly found: 'yes' | 'no' | 'unknown';
  /** How old the Mac's relay record is (ms), when there is one. */
  readonly recordAge?: number;
}

export class DialError extends Error {
  constructor(
    message: string,
    readonly report: DialReport,
  ) {
    super(message);
  }
}

/** hyperdht's error codes, as attempt outcomes. */
function p2pOutcome(code: string | undefined): DialAttempt['outcome'] {
  if (!code) return 'failed';
  if (code === 'PEER_NOT_FOUND') return 'not-found';
  if (/HOLEPUNCH|CANNOT_HOLEPUNCH|REMOTE_NOT_HOLEPUNCH|DOUBLE_RANDOMIZED/.test(code)) return 'unreachable';
  if (code === 'PEER_CONNECTION_FAILED' || code === 'SERVER_ERROR' || code === 'REMOTE_ABORTED') return 'refused';
  return 'failed';
}

/** A relay socket's close: 4404/404 nothing listens there (the Mac's gone), 4403 refused, else lost. */
function relayOutcome(code: number | undefined): DialAttempt['outcome'] {
  if (code === 4404 || code === 404 || code === 530 || code === 502) return 'not-found';
  if (code === 4403 || code === 403) return 'refused';
  if (code === undefined || code === 1006) return 'unreachable';
  return 'failed';
}

/** Race the ways to the Mac; the first whose Noise handshake opens with the right key wins. */
export function dialMac(opts: DialOptions): Promise<Dialed> {
  const target = opts.target;
  const tried: DialAttempt[] = [];
  const start = Date.now();
  const stagger = opts.staggerMs ?? 1_500;
  const order: Array<'p2p' | 'relay'> = opts.prefer === 'relay' ? ['relay', 'p2p'] : ['p2p', 'relay'];
  let settled = false;
  let found: DialReport['found'] = 'unknown';
  let dht: DialReport['dht'] = 'unknown';
  let recordAge: number | undefined;
  let relays = [...new Set(opts.relays ?? [])];
  const live = new Set<NoiseStream>();

  return new Promise<Dialed>((resolve, reject) => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let pending = 0;
    const record = (a: DialAttempt): void => {
      if (!settled) tried.push({ ...a, ms: Date.now() - start });
    };
    const report = (): DialReport => {
      const d = dht === 'ok' ? 'ok' : (opts.probeDht?.() ?? dht);
      // "Not found" means nothing when the DHT can't be reached at all.
      const f = d === 'unreachable' && found === 'no' ? 'unknown' : found;
      return { tried, dht: d, found: f, ...(recordAge !== undefined ? { recordAge } : {}) };
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      fn();
    };
    const fail = (): void => {
      if (pending > 0 || settled || !started.p2p || !started.relay) return;
      const r = report();
      finish(() => reject(new DialError('Couldn’t reach your Mac', r)));
    };
    const win = (stream: NoiseStream, path: LinkPath, relay?: string): void => {
      if (settled) {
        stream.destroy();
        return;
      }
      // A way still trying when another connected: it's dropped (and said so).
      for (const w of order) if (started[w] && !tried.some((t) => t.way === w)) record({ way: w, outcome: 'lost' });
      for (const other of live) if (other !== stream) other.destroy();
      finish(() => resolve({ stream, path, tried, ...(relay ? { relay } : {}) }));
    };
    const started = { p2p: false, relay: false };
    // Each way starts when its turn comes, or as soon as the one before it has failed.
    const kick = (): void => {
      const next = order.find((w) => !started[w]);
      if (next) launch(next);
    };

    const launch = (way: 'p2p' | 'relay'): void => {
      if (started[way] || settled) return;
      started[way] = true;
      if (way === 'p2p') return p2p();
      return void relay();
    };

    const p2p = (): void => {
      if (opts.noP2p || !opts.node) {
        record({ way: 'p2p', outcome: 'skipped' });
        return void (kick(), fail());
      }
      pending++;
      let stream: NoiseStream & { opened?: Promise<boolean> };
      try {
        stream = opts.node.connect(b4a.from(target) as never, { keyPair: { publicKey: opts.keyPair.publicKey, secretKey: opts.keyPair.secretKey } as never }) as unknown as NoiseStream & { opened?: Promise<boolean> };
      } catch (err) {
        pending--;
        record({ way: 'p2p', outcome: 'failed', code: (err as { code?: string }).code ?? 'CONNECT' });
        return void (kick(), fail());
      }
      live.add(stream);
      let code: string | undefined;
      stream.on('error', (err) => (code = err.code ?? code));
      let once = false;
      const done = (ok: boolean): void => {
        if (once) return;
        once = true;
        pending--;
        live.delete(stream);
        if (ok && stream.remotePublicKey && b4a.equals(stream.remotePublicKey, target)) {
          dht = 'ok';
          found = 'yes';
          record({ way: 'p2p', outcome: 'ok' });
          const host = stream.rawStream?.remoteHost ?? '';
          return win(stream, PRIVATE.test(host) ? 'lan' : 'direct');
        }
        stream.destroy();
        const outcome = p2pOutcome(code);
        // The DHT answered either way when it says "not found" or that the hole-punch failed.
        if (code) dht = 'ok';
        if (outcome === 'unreachable' || outcome === 'refused') found = 'yes';
        else if (outcome === 'not-found' && found === 'unknown') found = 'no';
        record({ way: 'p2p', outcome, ...(code ? { code } : {}) });
        kick();
        fail();
      };
      stream.on('open', () => done(true));
      stream.on('close', () => done(false));
    };

    const relay = async (): Promise<void> => {
      if (!opts.openRelay) {
        record({ way: 'relay', outcome: 'skipped' });
        return void (kick(), fail());
      }
      pending++;
      // Known URLs first; then what the Mac's record on the DHT says now.
      if (opts.node?.mutableGet) {
        const rec = await lookupRelay(opts.node, target);
        if (rec.found) {
          dht = 'ok';
          recordAge = rec.at !== undefined ? Math.max(0, Date.now() - rec.at) : undefined;
          // A record from the last half hour: the Mac was there recently.
          if (recordAge !== undefined && recordAge < 30 * 60_000 && found === 'unknown') found = 'yes';
          if (rec.relay && !relays.includes(rec.relay)) relays = [rec.relay, ...relays];
        }
      }
      if (settled) return void pending--;
      if (!relays.length) {
        pending--;
        record({ way: 'relay', outcome: 'skipped', code: 'NO_RELAY' });
        return void (kick(), fail());
      }
      for (const base of relays) {
        if (settled) break;
        const url = relayUrlFor(base, b4a.toString(target, 'hex'));
        const outcome = await new Promise<DialAttempt['outcome']>((done) => {
          let pipe: MessagePipe;
          try {
            pipe = opts.openRelay!(url);
          } catch {
            return done('failed');
          }
          const s = noiseOverRelay(pipe, opts.keyPair, target);
          live.add(s);
          s.on('error', () => undefined);
          void s.opened.then((ok) => {
            live.delete(s);
            if (ok && s.remotePublicKey && b4a.equals(s.remotePublicKey, target)) {
              found = 'yes';
              record({ way: 'relay', outcome: 'ok' });
              win(s, 'relay', base);
              return done('ok');
            }
            s.destroy();
            const out = relayOutcome(s.raw.closeCode);
            if (out === 'refused') found = 'yes';
            record({ way: 'relay', outcome: out, ...(s.raw.closeCode !== undefined ? { code: String(s.raw.closeCode) } : {}) });
            done(out);
          });
        });
        if (outcome === 'ok') return void pending--;
      }
      pending--;
      kick();
      fail();
    };

    launch(order[0]!);
    timers.push(setTimeout(() => launch(order[1]!), stagger));
    timers.push(
      setTimeout(() => {
        for (const s of live) s.destroy();
        for (const w of order) if (!started[w]) record({ way: w, outcome: 'skipped' });
        for (const w of order) if (started[w] && !tried.some((t) => t.way === w)) record({ way: w, outcome: 'timeout' });
        const r = report();
        finish(() => reject(new DialError('Your Mac didn’t answer in time', r)));
      }, opts.timeoutMs ?? 20_000),
    );
  });
}
