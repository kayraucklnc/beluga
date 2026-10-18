import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../../src/net/crypto.js';
import { canonical } from '../../src/net/mesh/files.js';
import { checkProof, formatCode, newInvitation, pairProof, pairingSecrets, parseTicket } from '../../src/net/mesh/invitations.js';
import { meshKeys, openSealed, sealTo } from '../../src/net/mesh/keys.js';
import { Bucket } from '../../src/net/mesh/link.js';
import { PROTO, parseLink, parsePair } from '../../src/net/mesh/wire.js';

describe('invitations', () => {
  it('reads links and codes however they are pasted or typed', () => {
    const inv = newInvitation('friend');
    expect(parseTicket(`klaud://add#${inv.secret}`)).toEqual({ via: 'link', secret: inv.secret });
    expect(parseTicket(`join me: klaud://join#${inv.secret} thanks`)).toEqual({ via: 'link', secret: inv.secret });
    expect(parseTicket(formatCode(inv.code))).toEqual({ via: 'code', code: inv.code });
    expect(parseTicket(' k7qm 4xpa ')).toEqual({ via: 'code', code: 'K7QM4XPA' });
    // Letters people confuse with digits are read as the digits.
    expect(parseTicket('OIL0-0000')).toEqual({ via: 'code', code: '01100000' });
    expect(parseTicket('K7QM-4XP')).toBeUndefined();
    expect(parseTicket('klaud://add#short')).toBeUndefined();
    expect(parseTicket('hello world')).toBeUndefined();
  });

  it('turn into the same pairing keys on both sides, and proofs bound to role, connection and content', async () => {
    const inv = newInvitation('friend');
    const a = await pairingSecrets({ via: 'code', code: inv.code });
    const b = await pairingSecrets(parseTicket(formatCode(inv.code).toLowerCase())!);
    expect(a.seed.equals(b.seed) && a.auth.equals(b.auth)).toBe(true);
    const link = await pairingSecrets({ via: 'link', secret: inv.secret });
    expect(link.seed.equals(a.seed)).toBe(false);
    const hh = Buffer.alloc(32, 7);
    const proof = pairProof(a.auth, 'invitee', hh, 'me');
    expect(checkProof(b.auth, 'invitee', hh, 'me', proof)).toBe(true);
    expect(checkProof(b.auth, 'inviter', hh, 'me', proof)).toBe(false);
    expect(checkProof(b.auth, 'invitee', Buffer.alloc(32, 8), 'me', proof)).toBe(false);
    expect(checkProof(b.auth, 'invitee', hh, 'someone else', proof)).toBe(false);
    expect(checkProof(link.auth, 'invitee', hh, 'me', proof)).toBe(false);
  });
});

describe('wire protocol', () => {
  it('parses known messages and ignores unknown or malformed ones', () => {
    expect(parseLink(JSON.stringify({ t: 'hello', proto: PROTO, name: 'ann', presence: { state: 'online' } }))).toMatchObject({ t: 'hello' });
    expect(parseLink(JSON.stringify({ t: 'from_the_future', x: 1 }))).toBeUndefined();
    expect(parseLink(JSON.stringify({ t: 'dm', id: 'short', text: 'x', ts: 1 }))).toBeUndefined();
    expect(parseLink(JSON.stringify({ t: 'dm', id: 'abcdefgh', text: 'x'.repeat(8_001), ts: 1 }))).toBeUndefined();
    expect(parseLink(JSON.stringify({ t: 'g_heads', group: 'x', heads: [] }))).toBeUndefined();
    expect(parseLink('{not json')).toBeUndefined();
    expect(parsePair(JSON.stringify({ t: 'pair_refused', reason: 'no' }))).toEqual({ t: 'pair_refused', reason: 'no' });
    expect(parsePair(JSON.stringify({ t: 'pair_hello', proto: 1, mac: 'x' }))).toBeUndefined();
  });

  it('rate-limits a link with a token bucket', () => {
    const bucket = new Bucket(10, 5);
    const taken = Array.from({ length: 8 }, () => bucket.take()).filter(Boolean).length;
    expect(taken).toBe(5);
  });

  it('keeps canonical JSON stable regardless of key order', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: undefined, e: null }] })).toBe('{"a":[{"d":2,"e":null}],"b":1}');
  });
});

describe('sealed boxes', () => {
  it('open only for the person they were sealed to, with the same label', async () => {
    const [ann, bob] = await Promise.all([meshKeys(generateIdentity()), meshKeys(generateIdentity())]);
    const box = sealTo(ann.card.box, Buffer.from('chain key'), 'label');
    expect(openSealed(ann, box, 'label')?.toString()).toBe('chain key');
    expect(openSealed(bob, box, 'label')).toBeUndefined();
    expect(openSealed(ann, box, 'other label')).toBeUndefined();
    expect(openSealed(ann, { ...box, ct: Buffer.from('tampered').toString('base64') }, 'label')).toBeUndefined();
  });
});
