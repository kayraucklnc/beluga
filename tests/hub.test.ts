import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { PeerClient, type IncomingMessage } from '../src/net/peer-client.js';
import type { PeerInfo } from '../src/protocol.js';
import { waitFor } from './helpers.js';

const secret = generateSecret();
const keys = deriveKeys(secret);
let hub: Hub;
const clients: PeerClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await hub?.close();
});

function join(name: string, k = keys): { client: PeerClient; inbox: IncomingMessage[]; peers: () => readonly PeerInfo[]; errors: string[]; self: () => PeerInfo | undefined } {
  const client = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys: k, profile: { name, shares: [], agent: true }, reconnect: false });
  const inbox: IncomingMessage[] = [];
  const errors: string[] = [];
  let peers: readonly PeerInfo[] = [];
  let self: PeerInfo | undefined;
  client.on('message', (m) => inbox.push(m));
  client.on('peers', (p) => (peers = p));
  client.on('error', (e) => errors.push(e));
  client.on('welcome', (p) => (self = p));
  client.connect();
  clients.push(client);
  return { client, inbox, peers: () => peers, errors, self: () => self };
}

describe('hub', () => {
  it('authenticates peers, shares presence and dedupes names', async () => {
    hub = await startHub({ keys });
    const a = join('kay');
    const b = join('kay');
    await waitFor(() => a.peers().length === 2 && b.peers().length === 2);
    expect(a.peers().map((p) => p.name).sort()).toEqual(['kay', 'kay-2']);
    expect(b.self()?.name).toBe('kay-2');
    b.client.close();
    await waitFor(() => a.peers().length === 1);
  });

  it('broadcasts and direct-messages encrypted bodies', async () => {
    hub = await startHub({ keys });
    const a = join('a');
    const b = join('b');
    const c = join('c');
    await waitFor(() => c.peers().length === 3 && a.client.connected);
    a.client.send({ kind: 'chat', text: 'hello all' });
    await waitFor(() => b.inbox.length && c.inbox.length && a.inbox.length);
    expect(b.inbox[0]).toMatchObject({ from: a.client.peerId, body: { kind: 'chat', text: 'hello all', byAgent: false } });

    a.client.send({ kind: 'chat', text: 'psst' }, { to: b.client.peerId });
    await waitFor(() => b.inbox.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.inbox).toHaveLength(1);
    expect(a.inbox).toHaveLength(1);
  });

  it('replays kept history to late joiners', async () => {
    hub = await startHub({ keys, historyLimit: 2 });
    const a = join('a');
    await waitFor(() => a.client.connected);
    for (const text of ['1', '2', '3']) a.client.send({ kind: 'chat', text }, { keep: true });
    a.client.send({ kind: 'chat', text: 'ephemeral' });
    await waitFor(() => a.inbox.length === 4);
    const late = join('late');
    await waitFor(() => late.inbox.length === 2);
    expect(late.inbox.map((m) => (m.body.kind === 'chat' ? m.body.text : ''))).toEqual(['2', '3']);
  });

  it('rejects the wrong secret', async () => {
    hub = await startHub({ keys });
    const bad = join('mallory', deriveKeys(generateSecret()));
    await waitFor(() => bad.errors.some((e) => e.includes('Authentication failed')));
    expect(bad.client.connected).toBe(false);
  });

  it('enforces room size and auth timeout, ignores junk', async () => {
    hub = await startHub({ keys, maxPeers: 1, authTimeoutMs: 100 });
    const a = join('a');
    await waitFor(() => a.client.connected);
    const b = join('b');
    await waitFor(() => b.errors.includes('Room is full'));

    const raw = new WebSocket(`ws://127.0.0.1:${hub.port}`);
    const closed = new Promise<number>((resolve) => raw.on('close', (code) => resolve(code)));
    raw.on('open', () => raw.send('not json'));
    expect(await closed).toBe(4005);
  });

  it('rate limits floods', async () => {
    hub = await startHub({ keys, rateLimit: 5 });
    const a = join('a');
    await waitFor(() => a.client.connected);
    for (let i = 0; i < 50; i++) a.client.send({ kind: 'chat', text: `m${i}` });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.inbox.length).toBeLessThan(10);
  });

  it('accepts profile updates', async () => {
    hub = await startHub({ keys });
    const a = join('a');
    const b = join('b');
    await waitFor(() => b.peers().length === 2);
    a.client.updateProfile({ name: 'ignored', shares: [{ name: 'docs', writable: false }], agent: false });
    await waitFor(() => b.peers().find((p) => p.peerId === a.client.peerId)?.shares.length === 1);
    expect(b.peers().find((p) => p.peerId === a.client.peerId)).toMatchObject({ name: 'a', agent: false });
  });
});

describe('hub resilience', () => {
  it('does not duplicate history after a reconnect', async () => {
    hub = await startHub({ keys });
    const port = hub.port;
    const a = join('a');
    await waitFor(() => a.client.connected);
    a.client.send({ kind: 'chat', text: 'kept' }, { keep: true });
    const b = new PeerClient({ url: `ws://127.0.0.1:${port}`, keys, profile: { name: 'b', shares: [], agent: false } });
    clients.push(b);
    const inbox: IncomingMessage[] = [];
    b.on('message', (m) => inbox.push(m));
    b.connect();
    await waitFor(() => inbox.length === 1);
    // Drop b's socket; it reconnects and receives the same history again.
    (b as unknown as { ws: WebSocket }).ws.terminate();
    await waitFor(() => !b.connected);
    await waitFor(() => b.connected, 5000);
    a.client.send({ kind: 'chat', text: 'after' });
    await waitFor(() => inbox.length === 2);
    expect(inbox.map((m) => (m.body.kind === 'chat' ? m.body.text : ''))).toEqual(['kept', 'after']);
  });

  it('rejects oversized pre-auth frames', async () => {
    hub = await startHub({ keys });
    const raw = new WebSocket(`ws://127.0.0.1:${hub.port}`);
    const closed = new Promise<number>((resolve) => raw.on('close', (code) => resolve(code)));
    raw.on('open', () => raw.send('x'.repeat(20_000)));
    expect(await closed).toBe(4007);
  });

  it('caps history by bytes so welcome frames stay deliverable', async () => {
    hub = await startHub({ keys, historyLimit: 1000 });
    const a = join('a');
    await waitFor(() => a.client.connected);
    const big = 'x'.repeat(60_000);
    for (let i = 0; i < 40; i++) a.client.send({ kind: 'chat', text: `${i}${big}` }, { keep: true });
    await waitFor(() => a.inbox.length === 40, 5000);
    const late = join('late');
    await waitFor(() => late.client.connected, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(late.inbox.length).toBeGreaterThan(5);
    expect(late.inbox.length).toBeLessThan(40);
  });
});
