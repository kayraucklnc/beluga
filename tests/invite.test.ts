import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite, findInvite, toWsUrl } from '../src/net/invite.js';

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
    expect(() => decodeInvite("klaude:%%%")).toThrow(/corrupted/);
    expect(() => decodeInvite(`klaude:${Buffer.from('{"url":"http://x"}').toString('base64url')}`)).toThrow(/invalid/);
  });

  it('rejects garbage', () => {
    expect(() => decodeInvite('nope')).toThrow(/does not look like/);
    expect(() => decodeInvite('https://x.com#short')).toThrow(/invalid/);
    expect(() => decodeInvite(`https://good.com@evil.com#${secret}`)).toThrow(/does not look like/);
    expect(findInvite(`https://good.com@evil.com#${secret}`)).toBeUndefined();
  });

  it('finds invites inside pasted text', () => {
    expect(findInvite(`hey join me: klaud join https://a-b.trycloudflare.com#${secret} !`)).toBe(`https://a-b.trycloudflare.com#${secret}`);
    expect(findInvite("klaud join klaude:eyJ1cmwiOiJ3c3M6Ly94In0abc")).toBe("klaude:eyJ1cmwiOiJ3c3M6Ly94In0abc");
    expect(findInvite('nothing here')).toBeUndefined();
  });

  it('converts tunnel URLs to websocket URLs', () => {
    expect(toWsUrl('https://x.trycloudflare.com/')).toBe('wss://x.trycloudflare.com');
    expect(toWsUrl('http://localhost:1')).toBe('ws://localhost:1');
  });
});
