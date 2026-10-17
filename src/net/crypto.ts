import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Box } from '../protocol.js';

/** Keys derived from the room secret. The secret itself never goes on the wire. */
export interface RoomKeys {
  readonly enc: Buffer;
  readonly auth: Buffer;
}

export function generateSecret(): string {
  // 144 bits: plenty for HKDF-derived keys, short enough to paste comfortably.
  return randomBytes(18).toString('base64url');
}

export function deriveKeys(secret: string): RoomKeys {
  if (secret.length < 16) throw new Error('Room secret is too short');
  const ikm = Buffer.from(secret, 'utf8');
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', ikm, Buffer.from('klaude-v1'), Buffer.from(info), 32));
  return { enc: derive('enc'), auth: derive('auth') };
}

export function seal(keys: RoomKeys, value: unknown): Box {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Decrypt a box. Returns undefined when tampered with or encrypted for another room. */
export function open(keys: RoomKeys, box: Box): unknown {
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.enc, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    return undefined;
  }
}

export function newNonce(): string {
  return randomBytes(24).toString('base64');
}

export function proveNonce(keys: RoomKeys, nonce: string, peerId: string): string {
  return createHmac('sha256', keys.auth).update(`${nonce}:${peerId}`).digest('base64');
}

export function verifyProof(keys: RoomKeys, nonce: string, peerId: string, proof: string): boolean {
  const expected = Buffer.from(proveNonce(keys, nonce, peerId), 'base64');
  const actual = Buffer.from(proof, 'base64');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
