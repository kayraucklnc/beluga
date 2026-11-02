import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DHT from 'hyperdht';
import { describe, expect, it } from 'vitest';
import { DeviceBook } from '../src/companion/devices.js';
import { DevicePairing } from '../src/companion/pair.js';
import { generateIdentity } from '../src/net/crypto.js';

/**
 * Pair a Phone… opens fast (BLG-73): the link and the code listen side by side, the QR shows as
 * soon as the link listens, and nothing waits for the code's Argon2id or the relay's tunnel.
 */

interface FakeServer {
  readonly listened: Promise<void>;
  release(): void;
  fail(err: Error): void;
  closed: boolean;
}

/** A DHT node whose servers listen only when the test says so. */
function fakeNode() {
  const servers: FakeServer[] = [];
  const node = {
    createServer() {
      let release!: () => void;
      let fail!: (err: Error) => void;
      const listened = new Promise<void>((res, rej) => ((release = res), (fail = rej)));
      const server: FakeServer & { listen(): Promise<void>; close(): Promise<void> } = {
        listened,
        release: () => release(),
        fail: (err) => fail(err),
        closed: false,
        listen: () => listened,
        close: async () => void (server.closed = true),
      };
      servers.push(server);
      return server;
    },
  };
  return { node: node as unknown as DHT, servers };
}

const waitUntil = async (ok: () => boolean, ms = 10_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function pairing(node: DHT, extra: { relayUrl?: () => string | undefined; log?: (line: string) => void } = {}) {
  const changes: number[] = [];
  const p = new DevicePairing({
    node: async () => node,
    identity: generateIdentity(),
    devices: new DeviceBook(path.join(mkdtempSync(path.join(os.tmpdir(), 'beluga-pair-')), 'devices.json')),
    address: () => 'ab',
    macName: () => 'Mac',
    onChange: () => changes.push(Date.now()),
    ...extra,
  });
  return { p, changes };
}

describe('opening a pairing', () => {
  it('shows the QR once the link listens, while the code still derives and listens', async () => {
    const { node, servers } = fakeNode();
    const { p, changes } = pairing(node);
    let done = false;
    const started = p.start().then((info) => ((done = true), info));
    // The link's key comes at once: its server is made before the code's Argon2id is done.
    await waitUntil(() => servers.length >= 1);
    expect(done).toBe(false);
    servers[0]!.release();
    const info = await started;
    expect(info.link).toMatch(/^beluga:\/\/device#/);
    expect(info.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(changes).toHaveLength(1);
    // The code listens too, and says so (its key pair joins the relay record).
    await waitUntil(() => servers.length === 2);
    expect(p.keyPairs()).toHaveLength(2);
    servers[1]!.release();
    await waitUntil(() => changes.length === 2);
    await p.cancel();
    expect(servers.every((s) => s.closed)).toBe(true);
  });

  it('listens for the link and the code at the same time, not one after the other', async () => {
    const { node, servers } = fakeNode();
    const { p } = pairing(node);
    const started = p.start();
    // Both servers are listening before either has answered.
    await waitUntil(() => servers.length === 2);
    servers[1]!.release();
    servers[0]!.release();
    await started;
    await p.cancel();
  });

  it('does not wait for the relay: its URL joins the link whenever it is up', async () => {
    const { node, servers } = fakeNode();
    let relay: string | undefined;
    const { p } = pairing(node, { relayUrl: () => relay });
    const started = p.start();
    await waitUntil(() => servers.length >= 1);
    servers[0]!.release();
    expect((await started).link).not.toContain('r=');
    relay = 'wss://x.trycloudflare.com/companion';
    expect(p.info()!.link).toContain('r=');
    await p.cancel();
  });

  it('a link that cannot listen fails the pairing; a code that cannot only says so', async () => {
    const { node, servers } = fakeNode();
    const { p } = pairing(node);
    const started = p.start();
    await waitUntil(() => servers.length >= 1);
    servers[0]!.fail(new Error('no network'));
    await expect(started).rejects.toThrow('no network');
    expect(p.isOpen).toBe(false);

    const lines: string[] = [];
    const second = fakeNode();
    const { p: q } = pairing(second.node, { log: (l) => lines.push(l) });
    const opening = q.start();
    await waitUntil(() => second.servers.length >= 1);
    second.servers[0]!.release();
    await opening;
    await waitUntil(() => second.servers.length === 2);
    second.servers[1]!.fail(new Error('busy'));
    await waitUntil(() => lines.length === 1);
    expect(lines[0]).toContain('the QR still works');
    expect(q.isOpen).toBe(true);
    await q.cancel();
  });
});
