import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite, findInvite, toWsUrl } from '../src/net/invite.js';
import { encodeKey } from '../src/net/p2p.js';

describe('invite', () => {
  const secret = 'tVh65bTGibnD1mD3ofr75-PD';

  it('encodes as a readable link and round-trips', () => {
    const code = encodeInvite({ url: 'wss://calm-river.trycloudflare.com', secret });
    expect(code).toBe(`https://calm-river.trycloudflare.com#${secret}`);
    expect(decodeInvite(`  ${code}\n`)).toEqual({ url: 'wss://calm-river.trycloudflare.com', secret });
    expect(decodeInvite(`http://10.0.0.5:4000/#${secret}`)).toEqual({ url: 'ws://10.0.0.5:4000', secret });
    expect(encodeInvite({ url: 'ws://10.0.0.5:4000', secret })).toBe(`http://10.0.0.5:4000#${secret}`);
  });

  it('still accepts legacy klaude: codes', () => {
    const legacy = `klaude:${Buffer.from(JSON.stringify({ url: 'wss://x.ngrok.app', secret, room: 'r' })).toString('base64url')}`;
    expect(decodeInvite(legacy)).toEqual({ url: 'wss://x.ngrok.app', secret, room: 'r' });
    expect(() => decodeInvite('klaude:%%%')).toThrow(/corrupted/);
    expect(() => decodeInvite(`klaude:${Buffer.from('{"url":"http://x"}').toString('base64url')}`)).toThrow(/invalid/);
  });

  it('rejects garbage', () => {
    expect(() => decodeInvite('nope')).toThrow(/does not look like/);
    expect(() => decodeInvite('https://x.com#short')).toThrow(/invalid/);
    expect(() => decodeInvite(`https://good.com@evil.com#${secret}`)).toThrow(/does not look like/);
    expect(findInvite(`https://good.com@evil.com#${secret}`)).toBeUndefined();
  });

  it('finds invites inside pasted text', () => {
    expect(findInvite(`hey join me: klaude join https://a-b.trycloudflare.com#${secret} !`)).toBe(`https://a-b.trycloudflare.com#${secret}`);
    expect(findInvite('klaude join klaude:eyJ1cmwiOiJ3c3M6Ly94In0abc')).toBe('klaude:eyJ1cmwiOiJ3c3M6Ly94In0abc');
    expect(findInvite('nothing here')).toBeUndefined();
  });

  describe('direct invites', () => {
    const key = encodeKey(Buffer.alloc(32, 7));
    const relay = 'wss://calm-river.trycloudflare.com';

    it('encode the host key, an optional relay, and keep the secret in the fragment', () => {
      expect(encodeInvite({ url: `p2p://${key}`, secret })).toBe(`klaude://${key}#${secret}`);
      const withRelay = encodeInvite({ url: `p2p://${key}`, relay, secret });
      expect(withRelay).toBe(`klaude://${key}?relay=https://calm-river.trycloudflare.com#${secret}`);
      expect(new URL(withRelay).hash).toBe(`#${secret}`);
      expect(decodeInvite(withRelay)).toEqual({ url: `p2p://${key}`, relay, secret });
      expect(decodeInvite(`klaude://${key}#${secret}`)).toEqual({ url: `p2p://${key}`, secret });
      // Percent-encoded relays (as some chat apps rewrite them) work too.
      expect(decodeInvite(`klaude://${key}/?relay=https%3A%2F%2Fcalm-river.trycloudflare.com#${secret}`).relay).toBe(relay);
      expect(decodeInvite(`klaude://${key}?relay=http://10.0.0.5:4000#${secret}`).relay).toBe('ws://10.0.0.5:4000');
    });

    it('reject bad keys and bad relays', () => {
      expect(() => decodeInvite(`klaude://${key.slice(1)}#${secret}`)).toThrow(/does not look like/);
      expect(() => decodeInvite(`klaude://${'l'.repeat(52)}#${secret}`)).toThrow(/does not look like/);
      expect(() => decodeInvite(`klaude://${key}?relay=https://good.com@evil.com#${secret}`)).toThrow(/invalid/);
      expect(() => decodeInvite(`klaude://${key}?relay=ftp://x.com#${secret}`)).toThrow(/invalid/);
      expect(() => decodeInvite(`klaude://${key}?relay=%E0%A4%A#${secret}`)).toThrow(/invalid/);
      expect(() => decodeInvite(`klaude://${key}#short`)).toThrow(/invalid/);
      expect(() => encodeInvite({ url: 'p2p://nope', secret })).toThrow();
    });

    it('are found inside pasted text, relay and all', () => {
      const link = `klaude://${key}?relay=https://a-b.trycloudflare.com#${secret}`;
      expect(findInvite(`join me: klaude join ${link} thanks`)).toBe(link);
      expect(findInvite(`klaude join klaude://${key}#${secret}.`)).toBe(`klaude://${key}#${secret}`);
    });
  });

  it('converts tunnel URLs to websocket URLs', () => {
    expect(toWsUrl('https://x.trycloudflare.com/')).toBe('wss://x.trycloudflare.com');
    expect(toWsUrl('http://localhost:1')).toBe('ws://localhost:1');
  });
});
