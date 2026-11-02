import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import DHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CompanionClient, DialError, pairDevice } from '../src/companion/client.js';
import { deviceKeys, newSeed, parseDeviceTicket } from '../src/companion/device-crypto.js';
import { DeviceBook } from '../src/companion/devices.js';
import { diagnose } from '../src/companion/diagnose.js';
import { CompanionHost } from '../src/companion/host.js';
import { HomeView } from '../src/companion/protocol.js';
import { wsPipe } from '../src/companion/relay.js';
import { Store, initialState } from '../src/core/store.js';
import { generateIdentity } from '../src/net/crypto.js';
import { waitFor } from './helpers.js';

/**
 * The relay path end to end, on a local testnet: the host turns every direct (hyperdht)
 * connection away, as a Wi-Fi with client isolation does, so pairing and the link must come
 * through the relay. A tapping proxy stands in for Cloudflare's tunnel and keeps every byte it
 * carries: it must never see plaintext.
 */

let testnet: Testnet;
const cleanup: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
}, 30_000);
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A WebSocket proxy to the host's relay server that records what passes (Cloudflare's view). */
async function tappingTunnel(seen: Buffer[]): Promise<(port: number) => Promise<{ url: string; close(): void }>> {
  return async (port) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (down, req) => {
      const up = new WebSocket(`ws://127.0.0.1:${port}${req.url ?? '/'}`);
      const queue: Buffer[] = [];
      const code = (c: number): number => (c >= 4000 || c === 1000 ? c : 1000);
      down.on('message', (data: Buffer) => {
        seen.push(Buffer.from(data));
        if (up.readyState === up.OPEN) up.send(data);
        else queue.push(data);
      });
      up.on('open', () => {
        for (const d of queue.splice(0)) up.send(d);
      });
      up.on('message', (data: Buffer) => {
        seen.push(Buffer.from(data));
        if (down.readyState === down.OPEN) down.send(data);
      });
      up.on('close', (c) => down.readyState === down.OPEN && down.close(code(c)));
      down.on('close', (c) => (up.readyState === up.OPEN ? up.close(code(c)) : up.terminate()));
      up.on('error', () => down.terminate());
      down.on('error', () => up.terminate());
    });
    const proxy = (wss.address() as AddressInfo).port;
    return { url: `ws://127.0.0.1:${proxy}/companion`, close: () => wss.close() };
  };
}

async function mac(seen: Buffer[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-relay-'));
  const identity = generateIdentity();
  const store = new Store(initialState('test room'));
  store.dispatch({ type: 'identity', selfId: identity.peerId, isHost: true });
  store.dispatch({ type: 'welcome', self: { peerId: identity.peerId, name: 'kayra', shares: [], agent: true } });
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  const calls: string[] = [];
  const host = new CompanionHost({
    identity,
    store,
    devices,
    call: async (_client, method) => {
      calls.push(method);
      return { ok: true, value: `did ${method}` };
    },
    macName: () => 'Kayra’s Mac',
    version: '0.13.1',
    thumbsDir: path.join(dir, 'thumbs'),
    uploadsDir: path.join(dir, 'uploads'),
    dht: { bootstrap: testnet.bootstrap, host: '127.0.0.1', refuseDirect: true },
    relay: await tappingTunnel(seen),
    coalesceMs: 50,
  });
  cleanup.push(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { host, store, devices, calls };
}

function phone() {
  const node = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
  cleanup.push(() => node.destroy({ force: true }));
  const keys = deviceKeys(newSeed());
  const sockets: WebSocket[] = [];
  const openRelay = (url: string) => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    return wsPipe(ws, false);
  };
  cleanup.push(() => sockets.forEach((s) => s.terminate()));
  return { node, keys, openRelay, device: { keys, name: 'Pixel 9', platform: 'android' as const, app: '1.1.0' } };
}

/** Nothing readable crossed the relay: no frame, no name, no proof, no certificate. */
function onlyCiphertext(seen: readonly Buffer[]): void {
  const all = Buffer.concat(seen).toString('latin1');
  expect(seen.length).toBeGreaterThan(4);
  for (const plain of ['"t":', 'dev_hello', 'dev_ok', 'welcome', 'hello', 'Pixel 9', 'kayra', 'Kayra', 'did host', 'host.answerApproval', 'beluga-device']) expect(all).not.toContain(plain);
}

describe('the relay, when a direct connection can’t be made', () => {
  it('pairs and links through it, with the same Noise inside, and the relay sees only ciphertext', async () => {
    const seen: Buffer[] = [];
    const { host, store, devices, calls } = await mac(seen);
    await host.start();
    await host.pairStart();
    // The QR's link carries the relay once its tunnel answers.
    const link = await waitFor(() => store.getState().companion.pairing?.link.includes('?r=') && store.getState().companion.pairing?.link, 10_000);
    const ticket = parseDeviceTicket(link);
    expect(ticket).toMatchObject({ via: 'link', relay: host.relayUrl() });

    const p = phone();
    const paired = pairDevice(p.node, link, p.device, { timeoutMs: 20_000, openRelay: p.openRelay, staggerMs: 200 });
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    const { id } = host.pairApprove();
    const result = await paired;
    expect(result.path).toBe('relay');
    expect(result.relay).toBe(host.relayUrl());

    const views: Array<{ topic: string; data: unknown }> = [];
    const client = new CompanionClient({ node: p.node, address: result.address, link: p.keys.link, app: '1.1.0', platform: 'android', topics: ['home'], hints: { openRelay: p.openRelay, relays: [result.relay!], staggerMs: 8_000 } });
    client.on('view', (topic, data) => views.push({ topic, data }));
    cleanup.push(() => client.close());
    const welcome = await client.connect();
    expect(client.path).toBe('relay');
    expect(welcome.relay).toBe(host.relayUrl());
    // The direct way was tried first and turned away; then the relay at once (not after the stagger).
    expect(client.tried.map((t) => [t.way, t.outcome])).toEqual([
      ['p2p', 'refused'],
      ['relay', 'ok'],
    ]);
    HomeView.parse((await waitFor(() => views.find((v) => v.topic === 'home'), 10_000)).data);
    expect(await client.call('host.answerApproval', ['yes', 'a1'])).toBe('did host.answerApproval');
    expect(calls).toEqual(['host.answerApproval']);

    // The Mac says how the phone came, in words.
    await waitFor(() => store.getState().companion.devices[0]?.path === 'relay', 5_000);
    expect(store.getState().companion.devices[0]).toMatchObject({ id, linked: true, path: 'relay', note: expect.stringMatching(/couldn’t connect directly.*relay/) });
    onlyCiphertext(seen);

    // A removed phone is turned away over the relay too.
    const closes: number[] = [];
    client.on('close', (code) => closes.push(code));
    host.removeDevice(id);
    await waitFor(() => closes.length > 0, 5_000);
    expect(closes[0]).toBe(4010);
    expect(devices.size).toBe(0);
  }, 60_000);

  it('a typed code finds the relay through the Mac’s record on the DHT', async () => {
    const seen: Buffer[] = [];
    const { host, store } = await mac(seen);
    await host.start();
    const info = await host.pairStart();
    await waitFor(() => host.relayUrl(), 10_000);
    // The relay record under the pairing's keys is on the DHT (put once the tunnel answered).
    await new Promise((r) => setTimeout(r, 500));
    const p = phone();
    const paired = pairDevice(p.node, info.code, p.device, { timeoutMs: 20_000, openRelay: p.openRelay, staggerMs: 200 });
    await waitFor(() => store.getState().companion.pairing?.waiting, 15_000);
    host.pairApprove();
    expect((await paired).path).toBe('relay');
    onlyCiphertext(seen);
  }, 60_000);

  it('explains when nothing gets through', async () => {
    const seen: Buffer[] = [];
    const { host } = await mac(seen);
    await host.start();
    const p = phone();
    // Nobody offers this pairing: hyperdht finds no one, and there's no relay to try.
    const err = await pairDevice(p.node, 'beluga://device#AAAAAAAAAAAAAAAAAAAAAA', p.device, { timeoutMs: 10_000, openRelay: p.openRelay, staggerMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DialError);
    const d = diagnose({ stage: 'pair', report: (err as DialError).report, online: true });
    expect(d.problem).toBe('pairing-gone');
    expect(d.title).not.toMatch(/[A-Z_]{6,}/);
  }, 60_000);
});
