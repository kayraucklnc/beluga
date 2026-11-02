import { coerceVoice, resolveVoice, type VoiceChoice, type VoiceModelId, type VoiceSetting } from '../../../src/shared/voice-models';
import { Resampler } from '../../../src/shared/voice-phrases';
import { toB64 } from './b64';
import { wavOf } from './dictate';
import { kv } from './kv';
import { calls } from './link/calls';
import type { TranscriptView } from './link/protocol';
import { store } from './store';
import { type AudioSource, useVoiceSession, type VoicePlatform, type VoiceSession } from './voice-session';
export type { Phrase, VoiceSession, VoiceView } from './voice-session';

/**
 * The web build speaks through your Mac (BLG-161): the browser's microphone, each phrase written
 * down on the Mac (companion.transcribe; the demo Mac answers too). No model runs in the browser,
 * so there's no "on this phone" here, nor Settings › Voice.
 */

const hasMic = (): boolean => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
export const voiceAvailable = (): boolean => hasMic() && store.supports('voice');
export const voiceSetting = (): VoiceSetting => coerceVoice(kv.get('voice'));
export const setVoiceSetting = (v: VoiceSetting): void => kv.set('voice', v);
export const phoneGB = (): number | undefined => undefined;
/** Always the Mac here (its model by the setting's language: Parakeet for English, Whisper Turbo otherwise). */
export const voiceChoice = (set: VoiceSetting = voiceSetting()): VoiceChoice => {
  const c = resolveVoice(set.preset === 'custom' ? { ...set, where: 'mac' } : { preset: 'suggested', language: set.language }, { macVoice: true });
  return { ...c, where: 'mac' };
};
export const phoneModelReady = (_id: VoiceModelId): boolean => false;
export const getPhoneModel = (_id: VoiceModelId, _onProgress: (p: number) => void): Promise<void> => Promise.reject(new Error('Not on the web'));
export const removePhoneModel = async (_id: VoiceModelId): Promise<void> => {};

function browserMic(): AudioSource {
  let stream: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let node: ScriptProcessorNode | undefined;
  return {
    async start(push) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(2048, 1, 1);
      const resample = new Resampler(ctx.sampleRate);
      node.onaudioprocess = (e) => push(resample.push(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
    },
    stop() {
      if (node) node.onaudioprocess = null;
      node?.disconnect();
      for (const t of stream?.getTracks() ?? []) t.stop();
      void ctx?.close().catch(() => undefined);
      node = undefined;
      stream = undefined;
      ctx = undefined;
    },
  };
}

const webPlatform: VoicePlatform = {
  choice: () => voiceChoice(),
  begin: () => {},
  prepare: async () => {
    if (store.getState().phase !== 'open') throw new Error('Your Mac is away: speaking needs it here.');
    return true;
  },
  allowed: async () => true,
  source: browserMic,
  async write(pcm, choice, prompt) {
    const ref = await store.put('voice.wav', 'audio/wav', toB64(wavOf(pcm)));
    const r = await store.call<TranscriptView>(calls.transcribe(ref, choice.model, choice.language, prompt), { queue: false });
    return { text: r?.text ?? '' };
  },
};

export function useVoice(on: { readonly text: (words: string) => void; readonly send: (words: string) => void }): VoiceSession {
  return useVoiceSession(webPlatform, on);
}
