import { type KeyObject, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';
import type { KeyPair } from 'hyperdht';
import { type Identity, peerIdFor } from '../crypto.js';

/**
 * Your keys on the klaud network, all derived from your identity (~/.klaud/identity.json), so
 * they're the same on every run and friends always find you at the same address:
 * - the address: the Noise key your Mac listens on in the peer-to-peer network;
 * - the box key: an X25519 key others seal group keys to.
 * Your card ties both to your identity with your signature, so nobody can pass off an address as yours.
 */

/** Who someone is on the network. Safe to share: public keys and a signature. */
export interface Card {
  readonly peerId: string;
  /** Identity key (base64 SPKI DER, as in crypto.ts). */
  readonly publicKey: string;
  /** Network address: the Noise public key (hex). */
  readonly address: string;
  /** X25519 public key for sealed boxes (hex). */
  readonly box: string;
  /** Identity signature over the three above. */
  readonly sig: string;
}

export interface MeshKeys {
  readonly identity: Identity;
  readonly card: Card;
  /** The Noise key pair your Mac listens with. Never leaves this process. */
  readonly keyPair: KeyPair;
  readonly boxPrivate: KeyObject;
}

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const seedOf = (identity: Identity): Buffer => {
  const d = identity.privateKey.export({ format: 'jwk' }).d;
  if (!d) throw new Error('Identity key has no private part');
  return Buffer.from(d, 'base64url');
};

const derive = (seed: Buffer, info: string): Buffer => Buffer.from(hkdfSync('sha256', seed, Buffer.from('klaud-mesh'), Buffer.from(info), 32));

const cardText = (peerId: string, address: string, box: string): Buffer => Buffer.from(`klaud-card-v1:${peerId}:${address}:${box}`);

export const x25519Private = (raw: Buffer): KeyObject => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' });
const x25519Public = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' });
const rawPublic = (key: KeyObject): Buffer => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);

/** Derive your network keys (needs hyperdht's key pair maker: the address is an Ed25519 Noise key). */
export async function meshKeys(identity: Identity): Promise<MeshKeys> {
  const DHT = (await import('hyperdht')).default;
  const seed = seedOf(identity);
  const keyPair = DHT.keyPair(derive(seed, 'address-v1'));
  const boxPrivate = x25519Private(derive(seed, 'box-v1'));
  const address = keyPair.publicKey.toString('hex');
  const box = rawPublic(boxPrivate).toString('hex');
  const sig = sign(null, cardText(identity.peerId, address, box), identity.privateKey).toString('base64');
  return { identity, keyPair, boxPrivate, card: { peerId: identity.peerId, publicKey: identity.publicKey, address, box, sig } };
}

const keyCache = new Map<string, KeyObject>();
function identityKey(publicKey: string): KeyObject {
  let key = keyCache.get(publicKey);
  if (!key) {
    key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (keyCache.size > 5000) keyCache.clear();
    keyCache.set(publicKey, key);
  }
  return key;
}

const HEX32 = /^[0-9a-f]{64}$/;

const probe = generateKeyPairSync('x25519').privateKey;
/** A box key others can actually seal to (not one of the weak points X25519 refuses). */
function usableBox(boxHex: string): boolean {
  try {
    return diffieHellman({ privateKey: probe, publicKey: x25519Public(Buffer.from(boxHex, 'hex')) }).some((b) => b !== 0);
  } catch {
    return false;
  }
}

const verified = new Set<string>();

/** A card is genuine: its peer id comes from its key, the key signed the address and box key, and the box key works. */
export function verifyCard(card: Card): boolean {
  const memo = `${card.peerId}:${card.publicKey}:${card.address}:${card.box}:${card.sig}`;
  if (verified.has(memo)) return true;
  try {
    if (!HEX32.test(card.address) || !HEX32.test(card.box)) return false;
    if (peerIdFor(card.publicKey) !== card.peerId) return false;
    const key = identityKey(card.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const ok = verify(null, cardText(card.peerId, card.address, card.box), key, Buffer.from(card.sig, 'base64')) && usableBox(card.box);
    if (ok) {
      if (verified.size > 5000) verified.clear();
      verified.add(memo);
    }
    return ok;
  } catch {
    return false;
  }
}

/** Sign text with your identity, under a label so a signature can't be reused for something else. */
export const signText = (identity: Identity, label: string, text: string): string => sign(null, Buffer.from(`${label}:${text}`), identity.privateKey).toString('base64');

export function verifyText(publicKey: string, label: string, text: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(`${label}:${text}`), identityKey(publicKey), Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Something sealed for one person's box key: only they can open it. */
export interface Sealed {
  readonly epk: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

const sealKey = (shared: Buffer, epk: Buffer, rpk: Buffer): Buffer => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, rpk]), Buffer.from('klaud-seal-v1'), 32));

/** Seal bytes to someone's box key (a fresh key each time: ephemeral X25519, then AES-256-GCM). */
export function sealTo(boxHex: string, plain: Buffer, aad: string): Sealed {
  const rpk = Buffer.from(boxHex, 'hex');
  const eph = generateKeyPairSync('x25519');
  const epk = rawPublic(eph.privateKey);
  const key = sealKey(diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(rpk) }), epk, rpk);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { epk: epk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Open something sealed to you; undefined when it isn't for you or was changed. */
export function openSealed(keys: Pick<MeshKeys, 'boxPrivate' | 'card'>, sealed: Sealed, aad: string): Buffer | undefined {
  try {
    const epk = Buffer.from(sealed.epk, 'base64');
    const key = sealKey(diffieHellman({ privateKey: keys.boxPrivate, publicKey: x25519Public(epk) }), epk, Buffer.from(keys.card.box, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
  } catch {
    return undefined;
  }
}
