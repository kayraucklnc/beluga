import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { decodeInvite, encodeInvite } from '../src/net/invite.js';
import { createNode, dialP2P, encodeKey } from '../src/net/p2p.js';
import { PeerClient, type IncomingMessage, type PeerClientOptions } from '../src/net/peer-client.js';
import { waitFor } from './helpers.js';

// Everything runs on a local testnet: these tests never touch the public DHT.
let testnet: Testnet;
const keys = deriveKeys(generateSecret());
let hub: Hub;
let key: string;
const clients: PeerClient[] = [];
const nodes: DHT[] = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
}, 30_000);
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const n of nodes.splice(0)) await n.destroy({ force: true });
  await hub?.close();
});

const p2p = (): { bootstrap: Testnet['bootstrap']; host: string } => ({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });

async function startP2PHub(opts: Partial<Parameters<typeof startHub>[0]> = {}): Promise<void> {
  hub = await startHub({ keys, ...opts });
  key = await hub.listenP2P(p2p());
}

function join(name: string, extra: Partial<PeerClientOptions> = {}): { client: PeerClient; inbox: IncomingMessage[]; ended: string[] } {
  const client = new PeerClient({ url: `p2p://${key}`, keys, profile: { name, shares: [], agent: false }, reconnect: false, p2p: p2p(), ...extra });
  const inbox: IncomingMessage[] = [];
  const ended: string[] = [];
  client.on('message', (m) => inbox.push(m));
  client.on('ended', (reason) => ended.push(reason));
  client.on('error', () => undefined);
  client.connect();
  clients.push(client);
  return { client, inbox, ended };
}

describe('hub over peer-to-peer', () => {
  it('connects two peers directly and relays sealed messages', async () => {
    await startP2PHub();
    expect(hub.p2pKey).toBe(key);
    expect(await hub.listenP2P(p2p())).toBe(key); // idempotent
    const a = join('a');
    const b = join('b');
    await waitFor(() => a.client.connected && b.client.connected, 15_000);
    expect(a.client.via).toBe(`p2p://${key}`);
    a.client.send({ kind: 'chat', text: 'direct hello' });
    await waitFor(() => b.inbox.length === 1, 5_000);
    expect(b.inbox[0]).toMatchObject({ from: a.client.peerId, body: { kind: 'chat', text: 'direct hello' } });
  }, 30_000);

  it('delivers fatal close codes: a removed peer stays out', async () => {
    await startP2PHub();
    const a = join('a');
    await waitFor(() => a.client.connected, 15_000);
    expect(hub.kick(a.client.peerId)).toBe(true);
    await waitFor(() => a.ended.length === 1, 5_000);
    expect(a.ended[0]).toMatch(/removed/);
  }, 30_000);

  it('turns newcomers away from a closed room with the closed code', async () => {
    await startP2PHub();
    hub.setOpen(false);
    // `ended` only fires for fatal close codes, so this proves 4008 crossed the stream intact.
    const b = join('b');
    await waitFor(() => b.ended.length === 1, 15_000);
    expect(b.ended[0]).toMatch(/isn't taking new people/);
  }, 30_000);

  it('reconnects over P2P after the stream drops', async () => {
    await startP2PHub();
    const a = join('a', { reconnect: true });
    await waitFor(() => a.client.connected, 15_000);
    (a.client as unknown as { socket: { terminate(): void } }).socket.terminate();
    await waitFor(() => !a.client.connected);
    await waitFor(() => a.client.connected, 15_000);
    expect(a.client.via).toBe(`p2p://${key}`);
  }, 30_000);

  it('enforces the pre-auth size limit on direct streams', async () => {
    await startP2PHub();
    const node = await createNode(p2p());
    nodes.push(node);
    const raw = dialP2P(node, key, { maxBytes: 1 << 20 });
    const closed = new Promise<number>((resolve) => raw.on('close', resolve));
    raw.on('open', () => raw.send('x'.repeat(20_000)));
    expect(await closed).toBe(4007);
  }, 30_000);

  it('gives up on a direct dial after the timeout', async () => {
    await startP2PHub();
    const node = await createNode(p2p());
    nodes.push(node);
    const raw = dialP2P(node, key, { maxBytes: 1024, timeoutMs: 1 });
    expect(await new Promise<number>((resolve) => raw.on('close', resolve))).toBe(1006);
  }, 30_000);
});

describe('falling back to the relay', () => {
  it('uses the ws relay when the host key is not on the DHT', async () => {
    hub = await startHub({ keys });
    // A host key nobody is listening on: the direct dial can't succeed.
    const nowhere = encodeKey(DHT.keyPair().publicKey);
    const invite = decodeInvite(encodeInvite({ url: `p2p://${nowhere}`, relay: `ws://127.0.0.1:${hub.port}`, secret: generateSecret() }));
    const client = new PeerClient({
      url: invite.url,
      ...(invite.relay ? { fallbackUrl: invite.relay } : {}),
      keys,
      profile: { name: 'c', shares: [], agent: false },
      reconnect: false,
      dialTimeoutMs: 300,
      p2p: p2p(),
    });
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e));
    clients.push(client);
    const started = Date.now();
    client.connect();
    await waitFor(() => client.connected, 10_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(client.via).toBe(`ws://127.0.0.1:${hub.port}`);
    expect(errors).toEqual([]);
  }, 30_000);

  it('uses the relay when a direct dial is too slow, and prefers what worked', async () => {
    await startP2PHub();
    const client = new PeerClient({
      url: `p2p://${key}`,
      fallbackUrl: `ws://127.0.0.1:${hub.port}`,
      keys,
      profile: { name: 'slow', shares: [], agent: false },
      dialTimeoutMs: 1,
      p2p: p2p(),
    });
    client.on('error', () => undefined);
    clients.push(client);
    client.connect();
    await waitFor(() => client.connected, 10_000);
    expect(client.via).toBe(`ws://127.0.0.1:${hub.port}`);
    (client as unknown as { socket: { terminate(): void } }).socket.terminate();
    await waitFor(() => !client.connected);
    await waitFor(() => client.connected, 10_000);
    expect(client.via).toBe(`ws://127.0.0.1:${hub.port}`);
  }, 30_000);
});
