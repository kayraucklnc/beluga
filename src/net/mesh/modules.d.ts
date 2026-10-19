// Minimal types for the extra parts of hyperdht and @hyperswarm/secret-stream the network uses.
declare module 'hyperdht' {
  interface NoiseSocket {
    /** The Noise handshake hash: the same on both ends of one connection, different on every other. */
    readonly handshakeHash: Buffer | null;
  }
}

declare module '@hyperswarm/secret-stream' {
  import type { Duplex } from 'node:stream';
  import type { KeyPair, NoiseSocket } from 'hyperdht';

  /** A Noise stream over any byte pipe: with no raw stream given, `rawStream` is the encrypted side to carry. */
  const NoiseSecretStream: new (isInitiator: boolean, rawStream: null, opts: { keyPair: KeyPair; remotePublicKey?: Buffer }) => NoiseSocket & { readonly rawStream: Duplex };
  export default NoiseSecretStream;
}
