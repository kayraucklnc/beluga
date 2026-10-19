import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Sender keys, the way Signal and WhatsApp encrypt groups: each member sends with their own
 * chain key, sealed once for every other member. Each message gets its own key, stepped forward
 * from the chain (message key = HMAC(chain, 1), next chain = HMAC(chain, 2)). When someone joins
 * or leaves, every member starts a new chain sealed only for the people in the group now, so
 * someone removed can't read what's written after.
 */

const step = (key: Buffer, byte: number): Buffer => createHmac('sha256', key).update(Buffer.from([byte])).digest();

export const newChainKey = (): Buffer => randomBytes(32);
export const newChainId = (): string => randomBytes(16).toString('hex');

/** Steps between remembered chain states: reading any message costs at most this many hashes. */
const CHECKPOINT = 64;

/**
 * Message keys for many chains. Remembers the chain state every few steps, so reading messages
 * in any order stays cheap (the group model also caps how far a number may jump ahead).
 */
export class Ratchets {
  private readonly points = new Map<string, Buffer[]>();

  messageKey(chain: string, initial: Buffer, n: number): Buffer {
    let points = this.points.get(chain);
    if (!points) {
      points = [initial];
      this.points.set(chain, points);
    }
    const from = Math.min(Math.floor(n / CHECKPOINT), points.length - 1);
    let key = points[from]!;
    for (let i = from * CHECKPOINT; i < n; i++) {
      key = step(key, 2);
      if ((i + 1) % CHECKPOINT === 0 && points.length === (i + 1) / CHECKPOINT) points.push(key);
    }
    return step(key, 1);
  }
}

export interface Ciphertext {
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

export const messageAad = (group: string, author: string, chain: string, n: number): string => `klaud-msg-v1:${group}:${author}:${chain}:${n}`;
export const keyAad = (group: string, author: string, chain: string, recipient: string): string => `klaud-sk-v1:${group}:${author}:${chain}:${recipient}`;

export function encrypt(key: Buffer, plain: string, aad: string): Ciphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function decrypt(key: Buffer, box: Ciphertext, aad: string): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
