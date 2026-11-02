// Minimal types for the parts of sodium-universal and b4a the companion uses (they ship none).
// Both come with hyperdht; they run unchanged in Node and in Holepunch's Bare (the phone's worklet).
declare module 'sodium-universal' {
  type Bytes = Uint8Array;
  export function crypto_generichash(out: Bytes, input: Bytes, key?: Bytes): void;
  export function crypto_pwhash(out: Bytes, passwd: Bytes, salt: Bytes, opslimit: number, memlimit: number, alg: number): void;
  export function crypto_pwhash_async(out: Bytes, passwd: Bytes, salt: Bytes, opslimit: number, memlimit: number, alg: number): Promise<void>;
  export function crypto_sign_seed_keypair(pk: Bytes, sk: Bytes, seed: Bytes): void;
  export function crypto_sign_detached(sig: Bytes, message: Bytes, sk: Bytes): void;
  export function crypto_sign_verify_detached(sig: Bytes, message: Bytes, pk: Bytes): boolean;
  export function crypto_box_seed_keypair(pk: Bytes, sk: Bytes, seed: Bytes): void;
  export function crypto_hash_sha256(out: Bytes, input: Bytes): void;
  export function randombytes_buf(out: Bytes): void;
  export function sodium_memcmp(a: Bytes, b: Bytes): boolean;
  export const crypto_pwhash_ALG_ARGON2ID13: number;
  export const crypto_sign_PUBLICKEYBYTES: number;
  export const crypto_sign_SECRETKEYBYTES: number;
  export const crypto_sign_BYTES: number;
  export const crypto_box_PUBLICKEYBYTES: number;
  export const crypto_box_SECRETKEYBYTES: number;
  const sodium: typeof import('sodium-universal');
  export default sodium;
}

declare module 'b4a' {
  type Bytes = Uint8Array;
  type Encoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'ascii' | 'latin1' | 'binary';
  export function alloc(size: number, fill?: number): Bytes;
  export function from(input: string, encoding?: Encoding): Bytes;
  export function from(input: ArrayLike<number> | ArrayBuffer): Bytes;
  export function toString(buf: Bytes, encoding?: Encoding, start?: number, end?: number): string;
  export function concat(list: readonly Bytes[], totalLength?: number): Bytes;
  export function equals(a: Bytes, b: Bytes): boolean;
  export function byteLength(input: string, encoding?: Encoding): number;
  export function isBuffer(value: unknown): value is Bytes;
  export function readUInt32BE(buf: Bytes, offset?: number): number;
  export function writeUInt32BE(buf: Bytes, value: number, offset?: number): number;
  const b4a: {
    alloc: typeof alloc;
    from: typeof from;
    toString: typeof toString;
    concat: typeof concat;
    equals: typeof equals;
    byteLength: typeof byteLength;
    isBuffer: typeof isBuffer;
    readUInt32BE: typeof readUInt32BE;
    writeUInt32BE: typeof writeUInt32BE;
  };
  export default b4a;
}

declare module 'streamx' {
  /** streamx's Duplex (what hyperdht and secret-stream are built on); the parts the relay uses. */
  export class Duplex {
    constructor(opts?: {
      open?: (this: Duplex, cb: (err?: Error | null) => void) => void;
      write?: (this: Duplex, data: Uint8Array, cb: (err?: Error | null) => void) => void;
      final?: (this: Duplex, cb: (err?: Error | null) => void) => void;
      destroy?: (this: Duplex, cb: (err?: Error | null) => void) => void;
      read?: (this: Duplex, cb: (err?: Error | null) => void) => void;
    });
    push(data: Uint8Array | null): boolean;
    write(data: Uint8Array): boolean;
    end(): void;
    destroy(err?: Error): void;
    readonly destroyed: boolean;
    on(event: string, fn: (...args: never[]) => void): this;
    once(event: string, fn: (...args: never[]) => void): this;
  }
}
