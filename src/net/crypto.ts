import { type KeyObject, createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';
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

/**
 * Each person's own signing key for this run. Their peer id is derived from the public
 * key, so nobody else (not even someone holding the invite) can claim it.
 */
export interface Identity {
  /** base64 SPKI DER of the Ed25519 public key. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
  readonly peerId: string;
}

export function peerIdFor(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64url').slice(0, 32);
}

export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey: pub, privateKey, peerId: peerIdFor(pub) };
}

/** Sign the hub's challenge (bound to the peer id) with your own key. */
export function signNonce(identity: Identity, nonce: string): string {
  return sign(null, Buffer.from(`klaude-id:${nonce}:${identity.peerId}`), identity.privateKey).toString('base64');
}

export function verifyNonce(publicKey: string, nonce: string, peerId: string, signature: string): boolean {
  try {
    if (peerIdFor(publicKey) !== peerId) return false;
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`klaude-id:${nonce}:${peerId}`), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
