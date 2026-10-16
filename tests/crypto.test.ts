import { describe, expect, it } from 'vitest';
import { deriveKeys, generateSecret, open, proveNonce, seal, verifyProof } from '../src/net/crypto.js';

describe('crypto', () => {
  const keys = deriveKeys(generateSecret());

  it('round-trips values through seal/open', () => {
    expect(open(keys, seal(keys, { hi: 'there', n: 1 }))).toEqual({ hi: 'there', n: 1 });
  });

  it('uses a fresh IV per message', () => {
    expect(seal(keys, 'x').iv).not.toEqual(seal(keys, 'x').iv);
  });

  it('rejects boxes from another room', () => {
    const other = deriveKeys(generateSecret());
    expect(open(other, seal(keys, 'secret'))).toBeUndefined();
  });

  it('rejects tampered ciphertext', () => {
    const box = seal(keys, 'hello world');
    const ct = Buffer.from(box.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    expect(open(keys, { ...box, ct: ct.toString('base64') })).toBeUndefined();
  });

  it('verifies HMAC proofs bound to nonce and peer id', () => {
    const proof = proveNonce(keys, 'nonce', 'peer');
    expect(verifyProof(keys, 'nonce', 'peer', proof)).toBe(true);
    expect(verifyProof(keys, 'nonce', 'other', proof)).toBe(false);
    expect(verifyProof(keys, 'other', 'peer', proof)).toBe(false);
    expect(verifyProof(keys, 'nonce', 'peer', 'short')).toBe(false);
  });

  it('refuses weak secrets', () => {
    expect(() => deriveKeys('short')).toThrow(/too short/);
  });
});
