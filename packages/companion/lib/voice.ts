import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { coerceVoice, resolveVoice, type VoiceChoice, type VoiceModelId, VOICE_MODELS, type VoiceSetting, type VoiceWhere, voiceKnows } from '../../../src/shared/voice-models';
import { fromB64, toB64 } from './b64';
import { cleanTranscript, joinPcm, MAX_BYTES, pcmLevel, SAMPLE_RATE, wavOf } from './dictate';
import { kv } from './kv';
import { calls } from './link/calls';
import type { TranscriptView } from './link/protocol';
import { store } from './store';

/**
 * Speak instead of typing (the Ask sheet's microphone, BLG-139). Where it's written down and by
 * which model is Settings › Voice (src/shared/voice-models.ts: presets, and the one suggested for
 * this phone and Mac):
 * - **On this phone**: Whisper Base, Whisper Turbo or Parakeet (whisper.cpp through whisper.rn).
 *   The model comes once, the first time it's needed, into the app's documents.
 * - **On your Mac**: the recording goes to the Mac as a WAV (`put`, then companion.transcribe); its
 *   GPU writes it down and deletes it. With the Mac away (or too old, or still getting its model),
 *   the phone writes it down itself and says so.
 * Tap to listen, tap again to write it down; the words go into the field to read over.
 */

// whisper.rn exports only subpaths (no '.'), so 'index' is its root; required untyped because its
// react-native entry is TypeScript source that doesn't pass this project's checks. What we use of it:
type Context = { transcribeData(pcm: ArrayBuffer, o: { language?: string }): { promise: Promise<{ result: string }> }; release(): Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rn = require('whisper.rn/index') as { initWhisper(o: { filePath: string }): Promise<Context>; initParakeet(o: { filePath: string }): Promise<Context> };

export type VoiceState = { kind: 'off' } | { kind: 'getting'; progress: number; model: VoiceModelId } | { kind: 'listening'; level: number } | { kind: 'writing'; where: VoiceWhere };

export const voiceAvailable = (): boolean => Platform.OS === 'android' || Platform.OS === 'ios';

/* ---------- The setting ---------- */

export const voiceSetting = (): VoiceSetting => coerceVoice(kv.get('voice'));
export const setVoiceSetting = (v: VoiceSetting): void => kv.set('voice', v);
/** This phone's memory in GB (the suggestion runs Turbo here only with enough of it). */
export const phoneGB = (): number | undefined => (Device.totalMemory ? Device.totalMemory / 1024 ** 3 : undefined);
/** What the setting means with this Mac (its version, not whether it's awake now: that's decided when you speak). */
export const voiceChoice = (set: VoiceSetting = voiceSetting()): VoiceChoice => resolveVoice(set, { macVoice: store.supports('voice'), phoneGB: phoneGB() });
const macOpen = (): boolean => store.supports('voice') && store.getState().phase === 'open';

/* ---------- The phone's models ---------- */

const dir = (): Directory => new Directory(Paths.document, 'voice');
const fileOf = (id: VoiceModelId): File => new File(dir(), VOICE_MODELS[id].files.phone!.name);
export const phoneModelReady = (id: VoiceModelId): boolean => {
  const want = VOICE_MODELS[id].files.phone;
  if (!want) return false;
  const f = fileOf(id);
  return f.exists && f.size === want.bytes;
};

const getting = new Map<VoiceModelId, Promise<void>>();
/** A model, once: to a part file first, so a download cut short never looks ready. */
export function getPhoneModel(id: VoiceModelId, onProgress: (p: number) => void): Promise<void> {
  const want = VOICE_MODELS[id].files.phone;
  if (!want) return Promise.reject(new Error(`${VOICE_MODELS[id].label} doesn’t run on the phone`));
  if (phoneModelReady(id)) return Promise.resolve();
  const on = getting.get(id);
  if (on) return on;
  const p = (async () => {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true });
    const part = new File(d, `${want.name}.part`);
    if (part.exists) part.delete();
    await File.downloadFileAsync(want.url, part, { onProgress: (e) => onProgress(e.bytesWritten / (e.totalBytes || want.bytes)) });
    if (part.size !== want.bytes) {
      part.delete();
      throw new Error('The voice model came incomplete. Try again on a steadier connection.');
    }
    const f = fileOf(id);
    if (f.exists) f.delete();
    part.move(f);
  })().finally(() => getting.delete(id));
  getting.set(id, p);
  return p;
}

/** Take a model off the phone (Settings › Voice). */
export async function removePhoneModel(id: VoiceModelId): Promise<void> {
  if (loaded?.id === id) await letGo();
  const f = fileOf(id);
  if (f.exists) f.delete();
}

/** The phone's model to fall back on: one already here that knows the language (the best first), else Base. */
function fallbackModel(language: string): VoiceModelId {
  return (['whisper-turbo', 'parakeet', 'whisper-base'] as const).find((id) => phoneModelReady(id) && voiceKnows(id, language)) ?? 'whisper-base';
}

// One model in memory while you dictate, let go a while after (Turbo holds about 1 GB).
let loaded: { id: VoiceModelId; ctx: Promise<Context> } | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
const IDLE_MS = 90_000;
async function letGo(): Promise<void> {
  const l = loaded;
  loaded = undefined;
  await l?.ctx.then((c) => c.release()).catch(() => {});
}
function contextFor(id: VoiceModelId): Promise<Context> {
  if (idle) clearTimeout(idle);
  if (loaded?.id === id) return loaded.ctx;
  void letGo();
  const filePath = fileOf(id).uri;
  const ctx = (VOICE_MODELS[id].kind === 'parakeet' ? rn.initParakeet({ filePath }) : rn.initWhisper({ filePath })).catch((e: unknown) => {
    if (loaded?.id === id) loaded = undefined;
    throw e;
  });
  loaded = { id, ctx };
  return ctx;
}
function letGoLater(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => void letGo(), IDLE_MS);
}

async function onPhone(id: VoiceModelId, pcm: Uint8Array, language: string): Promise<string> {
  const ctx = await contextFor(id);
  try {
    const { result } = await ctx.transcribeData(pcm.buffer as ArrayBuffer, VOICE_MODELS[id].kind === 'whisper' ? { language } : {}).promise;
    return result;
  } finally {
    letGoLater();
  }
}

async function onMac(model: VoiceModelId, pcm: Uint8Array, language: string): Promise<string> {
  const ref = await store.put('voice.wav', 'audio/wav', toB64(wavOf(pcm)));
  const r = await store.call<TranscriptView>(calls.transcribe(ref, model, language), { queue: false });
  return r?.text ?? '';
}

async function micAllowed(): Promise<boolean> {
  // iOS asks by itself when the recording starts (NSMicrophoneUsageDescription).
  if (Platform.OS !== 'android') return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, { title: 'Speak to Beluga', message: 'Beluga writes down what you say, on this phone or on your Mac, as you chose in Settings › Voice.', buttonPositive: 'Allow' });
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** The microphone: start listening (getting the phone's model first if it's needed and not here), stop to write it down. */
export function useVoice(onText: (words: string) => void): { state: VoiceState; start: () => Promise<void>; stop: () => void; cancel: () => void; error?: string; note?: string } {
  const [state, setState] = useState<VoiceState>({ kind: 'off' });
  const [error, setError] = useState<string | undefined>();
  // A quiet word on how it went (written on the phone instead of the Mac, and why).
  const [note, setNote] = useState<string | undefined>();
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

  const ensure = async (id: VoiceModelId): Promise<void> => {
    if (phoneModelReady(id)) return;
    setState({ kind: 'getting', progress: 0, model: id });
    await getPhoneModel(id, (progress) => setState({ kind: 'getting', progress, model: id }));
  };

  const finish = async (): Promise<void> => {
    if (!live.current) return;
    await halt();
    const pcm = joinPcm(chunks.current);
    chunks.current = [];
    bytes.current = 0;
    // Less than a third of a second is a tap, not words.
    if (pcm.length < SAMPLE_RATE * 2 * 0.3) return setState({ kind: 'off' });
    const choice = voiceChoice();
    try {
      let raw: string | undefined;
      if (choice.where === 'mac') {
        if (macOpen()) {
          setState({ kind: 'writing', where: 'mac' });
          raw = await onMac(choice.model, pcm, choice.language).catch((e: unknown) => {
            setNote(`${e instanceof Error ? e.message.replace(/\.$/, '') : 'Your Mac couldn’t'}: written on this phone instead.`);
            return undefined;
          });
        } else setNote(store.supports('voice') ? 'Your Mac is away: written on this phone instead.' : 'Your Mac needs an update to write it down: written on this phone.');
      }
      if (raw === undefined) {
        const id = choice.where === 'phone' ? choice.model : fallbackModel(choice.language);
        await ensure(id);
        setState({ kind: 'writing', where: 'phone' });
        raw = await onPhone(id, pcm, choice.language);
      }
      const words = cleanTranscript(raw);
      if (words) text.current(words);
      else setError('Didn’t catch that. Try again a little closer.');
    } catch (e) {
      setError(e instanceof Error && e.message.startsWith('The voice model') ? e.message : 'Couldn’t write that down. Try again.');
    } finally {
      setState({ kind: 'off' });
    }
  };

  const start = async (): Promise<void> => {
    if (state.kind !== 'off') return;
    setError(undefined);
    setNote(undefined);
    try {
      const choice = voiceChoice();
      // The phone's model before you speak, so it's written down the moment you stop.
      if (choice.where === 'phone') await ensure(choice.model);
      if (!(await micAllowed())) {
        setState({ kind: 'off' });
        return setError('Beluga needs the microphone to hear you (Settings › Apps › Beluga).');
      }
      // Load it while you speak, so writing it down starts at once.
      if (choice.where === 'phone') void contextFor(choice.model).catch(() => {});
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

  return { state, start, stop: () => void finish(), cancel, ...(error ? { error } : {}), ...(note ? { note } : {}) };
}
