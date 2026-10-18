import { afterEach, describe, expect, it } from 'vitest';
import { deriveKeys, generateSecret } from '../src/net/crypto.js';
import { startHub, type Hub } from '../src/net/hub.js';
import { CLOUDFLARE_URL, NGROK_URL, closeAllTunnels, openTunnel, waitUntilReachable } from '../src/net/tunnel.js';
import { osc52 } from '../src/ui/tty/clipboard.js';

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

  it('opens no tunnel when asked not to', async () => {
    expect(await openTunnel('none', 1234)).toBeUndefined();
  });
});

describe('clipboard', () => {
  it('builds OSC 52 sequences for terminals without a clipboard tool', () => {
    expect(osc52('hi')).toBe('\x1b]52;c;aGk=\x07');
  });
});
