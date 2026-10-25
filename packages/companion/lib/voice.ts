import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { fromB64 } from './b64';
import { cleanTranscript, joinPcm, MAX_BYTES, pcmLevel, SAMPLE_RATE } from './dictate';

/**
 * Speak instead of typing (the Ask sheet's microphone): Whisper runs on the phone (whisper.cpp,
 * whisper.rn), so what you say never leaves it. The model (Whisper base, multilingual, 57 MB) comes
 * once, the first time you tap the microphone, and stays in the app's documents. Tap to listen,
 * tap again to write it down; the words go into the field to read over before you send.
 */

// whisper.rn exports only subpaths (no '.'), so 'index' is its root; required untyped because its
// react-native entry is TypeScript source that doesn't pass this project's checks. What we use of it:
type WhisperContext = { transcribeData(pcm: ArrayBuffer, o: { language?: string }): { promise: Promise<{ result: string }> }; release(): Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { initWhisper } = require('whisper.rn/index') as { initWhisper(o: { filePath: string }): Promise<WhisperContext> };

export type VoiceState = { kind: 'off' } | { kind: 'getting'; progress: number } | { kind: 'listening'; level: number } | { kind: 'writing' };

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin';
const MODEL_BYTES = 59_707_625;
/** The model's size, for the first tap's line (57 MiB). */
export const MODEL_MB = 57;
const dir = (): Directory => new Directory(Paths.document, 'voice');
const modelFile = (): File => new File(dir(), 'ggml-base-q5_1.bin');

export const voiceAvailable = (): boolean => Platform.OS === 'android' || Platform.OS === 'ios';
export const modelReady = (): boolean => {
  const f = modelFile();
  return f.exists && f.size === MODEL_BYTES;
};

let getting: Promise<void> | undefined;
/** The model, once: to a part file first, so a download cut short never looks ready. */
function getModel(onProgress: (p: number) => void): Promise<void> {
  if (modelReady()) return Promise.resolve();
  getting ??= (async () => {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true });
    const part = new File(d, 'model.part');
    if (part.exists) part.delete();
    await File.downloadFileAsync(MODEL_URL, part, { onProgress: (e) => onProgress(e.bytesWritten / (e.totalBytes || MODEL_BYTES)) });
    if (part.size !== MODEL_BYTES) {
      part.delete();
      throw new Error('The voice model came incomplete. Try again on a steadier connection.');
    }
    const f = modelFile();
    if (f.exists) f.delete();
    part.move(f);
  })().finally(() => (getting = undefined));
  return getting;
}

// One Whisper in memory while you dictate, let go a while after (it holds about 100 MB).
let ctx: Promise<WhisperContext> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
const IDLE_MS = 90_000;
function whisper(): Promise<WhisperContext> {
  if (idle) clearTimeout(idle);
  const c = (ctx ??= initWhisper({ filePath: modelFile().uri }).catch((e: unknown) => {
    ctx = undefined;
    throw e;
  }));
  return c;
}
function letGoLater(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    const c = ctx;
    ctx = undefined;
    void c?.then((w) => w.release()).catch(() => {});
  }, IDLE_MS);
}

async function micAllowed(): Promise<boolean> {
  // iOS asks by itself when the recording starts (NSMicrophoneUsageDescription).
  if (Platform.OS !== 'android') return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, { title: 'Speak to Beluga', message: 'Beluga writes down what you say on this phone. Nothing you say leaves it.', buttonPositive: 'Allow' });
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** The microphone: start listening (getting the model first if it isn't here), stop to write it down. */
export function useVoice(onText: (words: string) => void): { state: VoiceState; start: () => Promise<void>; stop: () => void; cancel: () => void; error?: string } {
  const [state, setState] = useState<VoiceState>({ kind: 'off' });
  const [error, setError] = useState<string | undefined>();
  const chunks = useRef<Uint8Array[]>([]);
  const bytes = useRef(0);
  const live = useRef(false);
  const text = useRef(onText);
  text.current = onText;

  const halt = async (): Promise<void> => {
    if (!live.current) return;
    live.current = false;
    await Promise.resolve(LiveAudioStream.stop()).catch(() => {});
  };

  const finish = async (): Promise<void> => {
    if (!live.current) return;
    await halt();
    const pcm = joinPcm(chunks.current);
    chunks.current = [];
    bytes.current = 0;
    // Less than a third of a second is a tap, not words.
    if (pcm.length < SAMPLE_RATE * 2 * 0.3) return setState({ kind: 'off' });
    setState({ kind: 'writing' });
    try {
      const w = await whisper();
      const { result } = await w.transcribeData(pcm.buffer as ArrayBuffer, { language: 'auto' }).promise;
      const words = cleanTranscript(result);
      if (words) text.current(words);
      else setError('Didn’t catch that. Try again a little closer.');
    } catch {
      setError('Couldn’t write that down. Try again.');
    } finally {
      letGoLater();
      setState({ kind: 'off' });
    }
  };

  const start = async (): Promise<void> => {
    if (state.kind !== 'off') return;
    setError(undefined);
    try {
      if (!modelReady()) {
        setState({ kind: 'getting', progress: 0 });
        await getModel((progress) => setState({ kind: 'getting', progress }));
      }
      if (!(await micAllowed())) {
        setState({ kind: 'off' });
        return setError('Beluga needs the microphone to hear you (Settings › Apps › Beluga).');
      }
      // Load Whisper while you speak, so writing it down starts at once.
      void whisper().catch(() => {});
      chunks.current = [];
      bytes.current = 0;
      LiveAudioStream.init({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, audioSource: 6, bufferSize: 4096, wavFile: '' });
      LiveAudioStream.on('data', (b64: string) => {
        if (!live.current) return;
        const c = fromB64(b64);
        chunks.current.push(c);
        bytes.current += c.length;
        setState({ kind: 'listening', level: pcmLevel(c) });
        if (bytes.current >= MAX_BYTES) void finish();
      });
      live.current = true;
      LiveAudioStream.start();
      setState({ kind: 'listening', level: 0 });
    } catch (e) {
      live.current = false;
      setState({ kind: 'off' });
      setError(e instanceof Error && e.message.startsWith('The voice model') ? e.message : 'Couldn’t start listening. Check your connection and try again.');
    }
  };

  const cancel = (): void => {
    void halt();
    chunks.current = [];
    bytes.current = 0;
    setState((s) => (s.kind === 'listening' ? { kind: 'off' } : s));
  };

  // Leaving the sheet stops the microphone.
  useEffect(() => () => void halt(), []);

  return { state, start, stop: () => void finish(), cancel, ...(error ? { error } : {}) };
}
