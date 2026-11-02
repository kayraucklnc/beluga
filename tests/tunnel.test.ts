import { afterEach, describe, expect, it } from 'vitest';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { CLOUDFLARE_URL, NGROK_URL, closeAllTunnels, openTunnel, waitUntilReachable, watchTunnel } from '../src/net/tunnel.js';

let hub: Hub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

describe('tunnel helpers', () => {
  it('detects when the hub is reachable over HTTP', async () => {
    hub = await startHub({ keys: deriveKeys(generateSecret()) });
    expect(await waitUntilReachable(`http://127.0.0.1:${hub.port}`, 2000, 50)).toBe(true);
  });

  it('gives up on unreachable URLs', async () => {
    expect(await waitUntilReachable('http://127.0.0.1:1', 200, 50)).toBe(false);
  });

  it('picks the quick-tunnel URL, not cloudflared API error hosts', () => {
    expect(CLOUDFLARE_URL.exec('failed: https://api.trycloudflare.com/tunnel 429')).toBeNull();
    expect(CLOUDFLARE_URL.exec('|  https://calm-river-12.trycloudflare.com  |')?.[1]).toBe('https://calm-river-12.trycloudflare.com');
    expect(NGROK_URL.exec('{"msg":"started tunnel","url":"https://ab.ngrok.app"}')?.[1]).toBe('https://ab.ngrok.app');
    expect(() => closeAllTunnels()).not.toThrow();
  });

  it('calls a tunnel dead once its name stops answering while the internet still does', async () => {
    let up = true;
    let online = true;
    let dead = 0;
    const w = watchTunnel('https://calm-river-12.trycloudflare.com', () => dead++, {
      intervalMs: 20,
      graceMs: 0,
      answers: async (url) => (url.includes('trycloudflare') ? up : online),
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(dead).toBe(0);
    // Offline: the tunnel isn't blamed.
    up = false;
    online = false;
    await new Promise((r) => setTimeout(r, 80));
    expect(dead).toBe(0);
    online = true;
    await new Promise((r) => setTimeout(r, 120));
    expect(dead).toBe(1);
    w.stop();
  });

  it('gives a fresh name time to resolve', async () => {
    let dead = 0;
    const w = watchTunnel('https://new-name.trycloudflare.com', () => dead++, { intervalMs: 20, graceMs: 10_000, answers: async (url) => !url.includes('trycloudflare') });
    await new Promise((r) => setTimeout(r, 100));
    expect(dead).toBe(0);
    w.stop();
  });

  it('opens no tunnel when asked not to', async () => {
    expect(await openTunnel('none', 1234)).toBeUndefined();
  });
});
