import type DHT from 'hyperdht';
import type { BootstrapNode, NoiseSocket } from 'hyperdht';
import { type MessageSocket, fromStream } from './transport.js';

/**
 * Direct connections over the Hyperswarm DHT: UDP hole-punching plus a Noise
 * stream (forward secret, and the dialer pins the host's public key).
 */
export interface P2POptions {
  /** DHT bootstrap nodes. Defaults to the public Hyperswarm network; tests pass a local testnet. */
  readonly bootstrap?: readonly BootstrapNode[];
  /** Interface to bind (tests bind 127.0.0.1 to stay on loopback). */
  readonly host?: string;
}

/** How long a direct dial may take before we give up and try the relay. */
export const DIAL_TIMEOUT_MS = 10_000;

const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
/** z-base-32 (what hyperdht accepts): a 32-byte key becomes 52 lowercase letters/digits, easy to copy and spot in text. */
export function encodeKey(key: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += Z32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += Z32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * hyperdht loads native code (sodium-native, udx-native), so it is only imported when a direct
 * connection is wanted: if it can't load on some platform, relays and LAN rooms still work.
 */
let dhtModule: Promise<typeof DHT> | undefined;
const loadDHT = (): Promise<typeof DHT> => (dhtModule ??= import('hyperdht').then((m) => m.default));

export async function createNode(opts: P2POptions = {}): Promise<DHT> {
  const DHTNode = await loadDHT();
  return new DHTNode({ ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}), ...(opts.host ? { host: opts.host } : {}) });
}

export interface P2PServer {
  /** The address friends dial (z-base-32 public key). */
  readonly publicKey: string;
  close(): Promise<void>;
}

/**
 * Accept direct connections. A fresh key pair per run: the secret in the invite changes
 * every run anyway, and a long-lived key would let DHT observers link your sessions.
 */
export async function listenP2P(opts: P2POptions & { readonly maxBytes: number; readonly onSocket: (socket: MessageSocket) => void }): Promise<P2PServer> {
  const node = await createNode(opts);
  const keyPair = (await loadDHT()).keyPair();
  const server = node.createServer({}, (stream: NoiseSocket) => opts.onSocket(fromStream(stream, { maxBytes: opts.maxBytes, open: true })));
  try {
    await server.listen(keyPair);
  } catch (err) {
    await node.destroy({ force: true });
    throw err;
  }
  return {
    publicKey: encodeKey(keyPair.publicKey),
    close: async () => {
      await server.close().catch(() => undefined);
      await node.destroy({ force: true });
    },
  };
}

/**
 * Dial a host by its public key. Noise authenticates the host against the key, so nobody
 * in the middle can stand in for it. If the dial isn't open within `timeoutMs` it is dropped
 * (closing with 1006) so the caller can fall back to the relay.
 */
export function dialP2P(node: DHT, publicKey: string, opts: { readonly maxBytes: number; readonly timeoutMs?: number }): MessageSocket {
  const stream = node.connect(publicKey);
  const socket = fromStream(stream, { maxBytes: opts.maxBytes });
  const timer = setTimeout(() => socket.terminate(), opts.timeoutMs ?? DIAL_TIMEOUT_MS);
  timer.unref();
  socket.once('open', () => clearTimeout(timer));
  socket.once('close', () => clearTimeout(timer));
  return socket;
}
