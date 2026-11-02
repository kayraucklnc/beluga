/** The worklet's bundle (bare-pack output; an empty module until `npm run worklet:bundle`). */
declare module '*.bundle.mjs' {
  const bundle: string | Uint8Array | undefined;
  export default bundle;
}

/** Raw microphone PCM (lib/voice.ts); the package declares itself under its old name. */
declare module '@fugood/react-native-audio-pcm-stream' {
  const LiveAudioStream: {
    init(o: { sampleRate: number; channels: 1 | 2; bitsPerSample: 8 | 16; audioSource?: number; bufferSize?: number; wavFile: string }): Promise<void>;
    start(): void;
    /** The recorder lets go on its own thread a moment later. */
    stop(): void;
    on(event: 'data', callback: (b64: string) => void): void;
  };
  export default LiveAudioStream;
}
