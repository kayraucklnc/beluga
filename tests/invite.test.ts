import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite, toWsUrl } from '../src/net/invite.js';

describe('invite', () => {
  const invite = { url: 'wss://abc.ngrok.app', secret: 'a'.repeat(43), room: "kay's room" };

  it('round-trips', () => {
    const code = encodeInvite(invite);
    expect(code.startsWith('klaude:')).toBe(true);
    expect(decodeInvite(`  ${code}\n`)).toEqual(invite);
  });

  it('rejects garbage', () => {
    expect(() => decodeInvite('nope')).toThrow(/start with/);
    expect(() => decodeInvite('klaude:%%%')).toThrow();
    expect(() => decodeInvite(`klaude:${Buffer.from('{"url":"http://x"}').toString('base64url')}`)).toThrow(/invalid/);
  });

  it('converts tunnel URLs to websocket URLs', () => {
    expect(toWsUrl('https://x.trycloudflare.com/')).toBe('wss://x.trycloudflare.com');
    expect(toWsUrl('http://localhost:1')).toBe('ws://localhost:1');
  });
});
