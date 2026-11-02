// Minimal types for the parts of hyperdht Beluga uses (the package ships none).
declare module 'hyperdht' {
  import type { EventEmitter } from 'node:events';
  import type { Duplex } from 'node:stream';

  export interface KeyPair {
    readonly publicKey: Buffer;
    readonly secretKey: Buffer;
  }

  export type BootstrapNode = string | { readonly host: string; readonly port: number };

  export interface DHTOptions {
    readonly bootstrap?: readonly BootstrapNode[];
    readonly keyPair?: KeyPair;
    readonly connectionKeepAlive?: number | false;
    readonly host?: string;
    readonly port?: number;
    readonly ephemeral?: boolean;
  }

  /** A Noise-encrypted duplex stream (@hyperswarm/secret-stream). */
  export interface NoiseSocket extends Duplex {
    readonly remotePublicKey: Buffer;
    readonly publicKey: Buffer;
    readonly opened: Promise<boolean>;
  }

  export interface Server extends EventEmitter {
    listen(keyPair: KeyPair): Promise<void>;
    close(): Promise<void>;
    address(): { host: string; port: number; publicKey: Buffer } | null;
  }

  export default class DHT extends EventEmitter {
    constructor(opts?: DHTOptions);
    static keyPair(seed?: Buffer): KeyPair;
    createServer(opts?: { firewall?: (remotePublicKey: Buffer) => boolean }, onconnection?: (socket: NoiseSocket) => void): Server;
    connect(remotePublicKey: Buffer | string, opts?: { keyPair?: KeyPair }): NoiseSocket;
    ready(): Promise<void>;
    fullyBootstrapped(): Promise<void>;
    destroy(opts?: { force?: boolean }): Promise<void>;
    /** A signed, versioned value under a key pair's public key (the companion's relay record). */
    mutablePut(keyPair: KeyPair, value: Buffer, opts?: { seq?: number }): Promise<{ publicKey: Buffer; seq: number; signature: Buffer }>;
    mutableGet(publicKey: Buffer, opts?: { seq?: number; latest?: boolean }): Promise<{ value: Buffer; seq: number; signature: Buffer } | null>;
    readonly destroyed: boolean;
  }
}

declare module 'hyperdht/testnet.js' {
  import type DHT from 'hyperdht';
  import type { BootstrapNode, DHTOptions } from 'hyperdht';

  export interface Testnet {
    readonly nodes: DHT[];
    readonly bootstrap: BootstrapNode[];
    createNode(opts?: DHTOptions): DHT;
    destroy(): Promise<void>;
  }

  export default function createTestnet(size?: number, opts?: { host?: string; port?: number }): Promise<Testnet>;
}
