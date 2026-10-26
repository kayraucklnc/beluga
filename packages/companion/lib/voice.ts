import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { PermissionsAndroid, Platform } from 'react-native';
import { coerceVoice, resolveVoice, type VoiceChoice, type VoiceModelId, VOICE_MODELS, type VoiceSetting, type VoiceWhere, voiceKnows } from '../../../src/shared/voice-models';
import { fromB64, toB64 } from './b64';
import { floatsOf, SAMPLE_RATE, wavOf } from './dictate';
import { type AudioSource, useVoiceSession, type VoicePlatform, type VoiceSession } from './voice-session';
export type { Phrase, VoiceSession, VoiceView } from './voice-session';
import { kv } from './kv';
import { calls } from './link/calls';
import type { TranscriptView } from './link/protocol';
import { store } from './store';

/**
 * Speak instead of typing on the phone (the Ask sheet's and a conversation's microphone): each pause
 * cuts a phrase that's written down at once while you keep talking (lib/voice-session.ts). Where and
 * by which model is Settings › Voice (src/shared/voice-models.ts: presets, and the one suggested):
 * - **On this phone**: Whisper Base, Whisper Turbo or Parakeet (whisper.cpp through whisper.rn).
 *   The model comes once, the first time it's needed, into the app's documents.
 * - **On your Mac**: each phrase goes to the Mac as a WAV (`put`, then companion.transcribe); its
 *   GPU writes it down and deletes it. With the Mac away (or too old, or still getting its model),
 *   the phone writes the rest down itself and says so.
 */

// whisper.rn exports only subpaths (no '.'), so 'index' is its root; required untyped because its
// react-native entry is TypeScript source that doesn't pass this project's checks. What we use of it:
type Context = { transcribeData(pcm: ArrayBuffer, o: { language?: string; prompt?: string }): { promise: Promise<{ result: string }> }; release(): Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rn = require('whisper.rn/index') as { initWhisper(o: { filePath: string }): Promise<Context>; initParakeet(o: { filePath: string }): Promise<Context> };

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

async function onPhone(id: VoiceModelId, pcm: Uint8Array, language: string, prompt: string | undefined): Promise<string> {
  const ctx = await contextFor(id);
  try {
    const { result } = await ctx.transcribeData(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer, VOICE_MODELS[id].kind === 'whisper' ? { language, ...(prompt ? { prompt } : {}) } : {}).promise;
    return result;
  } finally {
    letGoLater();
  }
}

/** A phrase written down on your Mac (BLG-140): the WAV goes up (`put`), the words come back. */
export async function onMac(model: VoiceModelId, pcm: Uint8Array, language: string, prompt: string | undefined): Promise<string> {
  const ref = await store.put('voice.wav', 'audio/wav', toB64(wavOf(pcm)));
  const r = await store.call<TranscriptView>(calls.transcribe(ref, model, language, prompt), { queue: false });
  return r?.text ?? '';
}

async function micAllowed(): Promise<boolean> {
  // iOS asks by itself when the recording starts (NSMicrophoneUsageDescription).
  if (Platform.OS !== 'android') return true;
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, { title: 'Speak to Beluga', message: 'Beluga writes down what you say, on this phone or on your Mac, as you chose in Settings › Voice.', buttonPositive: 'Allow' });
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * The native recorder lets go of its AudioRecord on its own thread a read after stop (a buffer,
 * ~64 ms) and then nulls it: started again before that, the old thread releases the new recorder
 * and the app dies on a null one. So a new start waits for the last stop to settle.
 */
const SETTLE_MS = 300;
let settled: Promise<void> = Promise.resolve();

/** The microphone: 16 kHz 16-bit mono from the native recorder, as floats. */
function micSource(): AudioSource {
  let on = false;
  return {
    async start(push) {
      await settled;
      // Rejects when Android won't give the microphone (another app has it): an error, not silence.
      await LiveAudioStream.init({ sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16, audioSource: 6, bufferSize: 2048, wavFile: '' });
      LiveAudioStream.on('data', (b64: string) => on && push(floatsOf(fromB64(b64))));
      on = true;
      LiveAudioStream.start();
    },
    stop() {
      if (!on) return;
      on = false;
      LiveAudioStream.stop();
      settled = new Promise((r) => setTimeout(r, SETTLE_MS));
    },
  };
}

/** Why the Mac didn't write this time speaking (asked once, then the phone carries on). */
let macTrouble: string | undefined;

const nativePlatform: VoicePlatform = {
  choice: () => voiceChoice(),
  begin: () => void (macTrouble = undefined),
  async prepare(choice, onProgress) {
    // The phone's model before you speak, so each phrase is written the moment it's cut.
    if (choice.where === 'phone' && !phoneModelReady(choice.model)) {
      onProgress(choice.model, 0);
      await getPhoneModel(choice.model, (p) => onProgress(choice.model, p));
    }
    if (choice.where === 'phone') void contextFor(choice.model).catch(() => {});
    return true;
  },
  allowed: micAllowed,
  source: micSource,
  async write(pcm, choice, prompt) {
    if (choice.where === 'mac' && !macTrouble) {
      if (!macOpen()) macTrouble = store.supports('voice') ? 'Your Mac is away' : 'Your Mac needs an update to write it down';
      else {
        try {
          return { text: await onMac(choice.model, pcm, choice.language, prompt) };
        } catch (e) {
          macTrouble = e instanceof Error ? e.message.replace(/\.$/, '') : 'Your Mac couldn’t';
        }
      }
    }
    // On the phone: the chosen model, or (the Mac couldn't) the best one here that knows the language.
    const id = choice.where === 'phone' ? choice.model : fallbackModel(choice.language);
    if (!phoneModelReady(id)) await getPhoneModel(id, () => {});
    const text = await onPhone(id, pcm, choice.language, prompt);
    return { text, ...(choice.where === 'mac' ? { note: `${macTrouble}: written on this phone instead.` } : {}) };
  },
};

/** The microphone: start listening (getting the phone's model first if it's needed and not here); stop to edit, or to send it as said. */
export function useVoice(on: { readonly text: (words: string) => void; readonly send: (words: string) => void }): VoiceSession {
  return useVoiceSession(nativePlatform, on);
}
