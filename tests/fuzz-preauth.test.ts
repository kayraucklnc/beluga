import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { deriveKeys, generateIdentity, generateSecret, proveNonce, seal, signNonce } from '../src/net/crypto.js';
import { type Hub, startHub } from '../src/net/hub.js';
import { PeerClient } from '../src/net/peer-client.js';
import { fromStream } from '../src/net/transport.js';
import { waitFor } from './helpers.js';

/**
 * Someone who read the source and wrote their own client: whatever they send before they've
 * proved the invite, the hub neither crashes nor lets them in, and real members still join.
 * Seeded, so a failure replays.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const secret = generateSecret();
const keys = deriveKeys(secret);
let hub: Hub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

function junkValue(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * (depth > 2 ? 6 : 8));
  const str = (n: number) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(r() * 0xffff))).join('');
  switch (pick) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return [0, -1, 1e308, Number.MAX_SAFE_INTEGER, -0.5][Math.floor(r() * 5)];
    case 3: return str(Math.floor(r() * 40));
    case 4: return 'A'.repeat(Math.floor(r() * 20_000));
    case 5: return ['hello', 'msg', 'welcome', '__proto__', 'constructor'][Math.floor(r() * 5)];
    case 6: return Array.from({ length: Math.floor(r() * 4) }, () => junkValue(r, depth + 1));
    default: return Object.fromEntries(Array.from({ length: Math.floor(r() * 4) }, () => [['t', 'box', 'iv', 'ct', 'tag', 'peerId', '__proto__'][Math.floor(r() * 7)]!, junkValue(r, depth + 1)]));
  }
}

/** A hello that looks right, with one or two fields broken (or signed by someone without the invite). */
function brokenHello(r: () => number, nonce: string): string {
  const me = generateIdentity();
  const wrong = deriveKeys(generateSecret());
  const hello: Record<string, unknown> = {
    t: 'hello',
    peerId: me.peerId,
    proof: proveNonce(r() < 0.7 ? wrong : keys, nonce, me.peerId),
    pub: me.publicKey,
    sig: signNonce(me, nonce),
    box: seal(wrong, { name: 'mallory', shares: [], agent: true }),
  };
  const fields = Object.keys(hello);
  for (let i = 0; i < 1 + Math.floor(r() * 2); i++) hello[fields[Math.floor(r() * fields.length)]!] = junkValue(r);
  return JSON.stringify(hello);
}

function payload(r: () => number, nonce: string): string | Buffer {
  const kind = r();
  if (kind < 0.25) return Buffer.from(Array.from({ length: Math.floor(r() * 2048) }, () => Math.floor(r() * 256)));
  if (kind < 0.5) return JSON.stringify(junkValue(r));
  return brokenHello(r, nonce);
}

describe('pre-auth fuzzing', () => {
  it('the hub survives junk and broken hellos, lets nobody in, and still admits a real member', async () => {
    hub = await startHub({ keys, authTimeoutMs: 2_000 });
    const r = rng(0xbe1a6a);
    let admitted = 0;
    for (let round = 0; round < 40; round++) {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}`);
      await new Promise<void>((resolve) => {
        ws.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as { t: string; nonce?: string };
          if (frame.t === 'welcome') admitted++;
          if (frame.t !== 'challenge') return;
          for (let i = 0; i < 12 && ws.readyState === WebSocket.OPEN; i++) ws.send(payload(r, frame.nonce ?? ''));
          setTimeout(() => ws.close(), 20);
        });
        ws.on('close', () => resolve());
        ws.on('error', () => resolve());
      });
    }
    expect(admitted).toBe(0);

    const real = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, reconnect: false });
    real.connect();
    await waitFor(() => real.connected);
    real.close();
  }, 30_000);

  it('the direct-connection framing never hands on more than its limit, whatever bytes arrive', () => {
    const r = rng(0x5eed);
    const maxBytes = 4096;
    for (let run = 0; run < 200; run++) {
      const stream = new PassThrough();
      const socket = fromStream(stream, { maxBytes, open: true });
      const sizes: number[] = [];
      socket.on('message', (m) => sizes.push(Buffer.byteLength(m)));
      socket.on('error', () => undefined);
      for (let i = 0; i < 20; i++) {
        const chunk = Buffer.from(Array.from({ length: 5 + Math.floor(r() * 64) }, () => Math.floor(r() * 256)));
        // Now and then a well-formed header with a plausible length, so frames do get through.
        if (r() < 0.3) chunk.writeUInt32BE(Math.floor(r() * maxBytes * 2), 0);
        stream.emit('data', chunk);
      }
      expect(sizes.every((n) => n <= maxBytes)).toBe(true);
      socket.terminate();
    }
  });
});
