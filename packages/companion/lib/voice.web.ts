import { coerceVoice, resolveVoice, type VoiceChoice, type VoiceModelId, type VoiceSetting, type VoiceWhere } from '../../../src/shared/voice-models';
import { kv } from './kv';
import { store } from './store';

/** The web build has no on-device model nor microphone: no microphone in the Ask sheet, no Settings › Voice (lib/voice.ts). */
export type VoiceState = { kind: 'off' } | { kind: 'getting'; progress: number; model: VoiceModelId } | { kind: 'listening'; level: number } | { kind: 'writing'; where: VoiceWhere };

export const voiceAvailable = (): boolean => false;
export const voiceSetting = (): VoiceSetting => coerceVoice(kv.get('voice'));
export const setVoiceSetting = (v: VoiceSetting): void => kv.set('voice', v);
export const phoneGB = (): number | undefined => undefined;
export const voiceChoice = (set: VoiceSetting = voiceSetting()): VoiceChoice => resolveVoice(set, { macVoice: store.supports('voice') });
export const phoneModelReady = (_id: VoiceModelId): boolean => false;
export const getPhoneModel = (_id: VoiceModelId, _onProgress: (p: number) => void): Promise<void> => Promise.reject(new Error('Not on the web'));
export const removePhoneModel = async (_id: VoiceModelId): Promise<void> => {};

export function useVoice(_onText: (words: string) => void): { state: VoiceState; start: () => Promise<void>; stop: () => void; cancel: () => void; error?: string; note?: string } {
  return { state: { kind: 'off' }, start: async () => {}, stop: () => {}, cancel: () => {} };
}
