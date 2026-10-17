import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { deriveKeys, generateIdentity, generateSecret, proveNonce, seal, signNonce } from '../src/net/crypto.js';
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

  it('accepts profile updates, including unique renames', async () => {
    hub = await startHub({ keys });
    const a = join('a');
    const b = join('b');
    await waitFor(() => b.peers().length === 2);
    a.client.updateProfile({ name: 'ignored', shares: [{ name: 'docs', writable: false }], agent: false });
    await waitFor(() => b.peers().find((p) => p.peerId === a.client.peerId)?.shares.length === 1);
    expect(b.peers().find((p) => p.peerId === a.client.peerId)).toMatchObject({ name: 'ignored', agent: false });
    a.client.updateProfile({ name: 'b', shares: [], agent: false }); // taken by the other peer
    await waitFor(() => b.peers().find((p) => p.peerId === a.client.peerId)?.name === 'b-2');
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

describe('hub: removing people and replacing the invite', () => {
  it('marks the host in the peer list (peers cannot claim it)', async () => {
    const identity = generateIdentity();
    hub = await startHub({ keys, hostId: identity.peerId });
    const host = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'kay', shares: [], agent: true }, identity, reconnect: false });
    clients.push(host);
    let peers: readonly PeerInfo[] = [];
    host.on('peers', (p) => (peers = p));
    host.connect();
    const bob = join('bob');
    await waitFor(() => peers.length === 2 && bob.peers().length === 2);
    expect(bob.peers().find((p) => p.name === 'kay')?.host).toBe(true);
    expect(bob.peers().find((p) => p.name === 'bob')?.host).toBeUndefined();
  });

  it('removes someone, who cannot come back with the old link, while others keep talking', async () => {
    hub = await startHub({ keys });
    const a = join('a');
    const b = join('b');
    const ended: string[] = [];
    b.client.on('ended', (why) => ended.push(why));
    await waitFor(() => a.peers().length === 2);
    const fresh = generateSecret();
    hub.kick(b.client.peerId);
    hub.replaceInvite(fresh, deriveKeys(fresh));
    await waitFor(() => ended.length && a.peers().length === 1);
    expect(ended[0]).toContain('removed');

    // the old link no longer gets in
    const again = join('b2');
    await waitFor(() => again.errors.length);
    expect(again.errors[0]).toMatch(/no longer works/);

    // a newcomer with the new link joins and talks with the existing member (room key handed over)
    const c = join('c', deriveKeys(fresh));
    await waitFor(() => c.client.connected && a.peers().length === 2);
    c.client.send({ kind: 'chat', text: 'hi from the new link' });
    await waitFor(() => a.inbox.length);
    expect(a.inbox[0]?.body).toMatchObject({ text: 'hi from the new link' });
  });

  it('gives remaining members the new secret so they can reconnect', async () => {
    hub = await startHub({ keys });
    const a = join('a');
    const secrets: string[] = [];
    a.client.on('rekey', (s) => secrets.push(s));
    await waitFor(() => a.client.connected);
    const fresh = generateSecret();
    hub.replaceInvite(fresh, deriveKeys(fresh));
    await waitFor(() => secrets.length);
    expect(secrets[0]).toBe(fresh);
  });

  it('a closed room turns newcomers away but lets members back in', async () => {
    hub = await startHub({ keys });
    const memberA = generateIdentity();
    const a = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'a', shares: [], agent: true }, identity: memberA, reconnect: false });
    clients.push(a);
    a.connect();
    await waitFor(() => a.connected);
    hub.setOpen(false);
    expect(hub.isOpen).toBe(false);
    const stranger = join('stranger');
    await waitFor(() => stranger.errors.length);
    expect(stranger.errors[0]).toMatch(/isn't taking new people/);
    a.close();
    await new Promise((r) => setTimeout(r, 150)); // let the hub see the old connection go
    const back = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'a', shares: [], agent: true }, identity: memberA, reconnect: false });
    clients.push(back);
    back.connect();
    await waitFor(() => back.connected);
  });

  it('can forget the history late joiners see', async () => {
    hub = await startHub({ keys });
    const a = join('a');
    await waitFor(() => a.client.connected);
    a.client.send({ kind: 'chat', text: 'old news' }, { keep: true });
    await waitFor(() => a.inbox.length);
    hub.clearHistory();
    const late = join('late');
    await waitFor(() => late.client.connected);
    await new Promise((r) => setTimeout(r, 50));
    expect(late.inbox).toHaveLength(0);
  });

  it("nobody can take someone else's peer id, even with the invite", async () => {
    const host = generateIdentity();
    hub = await startHub({ keys, hostId: host.peerId });
    const impostor = generateIdentity();
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}`);
    const errors: string[] = [];
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'challenge') {
        // a valid invite proof and a real signature, but for the host's id
        ws.send(JSON.stringify({ t: 'hello', peerId: host.peerId, proof: proveNonce(keys, f.nonce, host.peerId), pub: impostor.publicKey, sig: signNonce(impostor, f.nonce), box: seal(keys, { name: 'evil', shares: [], agent: false }) }));
      }
      if (f.t === 'error') errors.push(f.message);
    });
    await waitFor(() => errors.length);
    expect(errors[0]).toMatch(/bad identity/);
    ws.close();
  });

  it('a member who was away when the invite changed can still come back (and gets the new link)', async () => {
    hub = await startHub({ keys });
    const me = generateIdentity();
    const first = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'a', shares: [], agent: true }, identity: me, reconnect: false });
    clients.push(first);
    first.connect();
    await waitFor(() => first.connected);
    first.close();
    await new Promise((r) => setTimeout(r, 50));
    const fresh = generateSecret();
    hub.replaceInvite(fresh, deriveKeys(fresh));
    const back = new PeerClient({ url: `ws://127.0.0.1:${hub.port}`, keys, profile: { name: 'a', shares: [], agent: true }, identity: me, reconnect: false });
    clients.push(back);
    const secrets: string[] = [];
    back.on('rekey', (s) => secrets.push(s));
    back.connect();
    await waitFor(() => back.connected && secrets.length);
    expect(secrets[0]).toBe(fresh);
  });
});
