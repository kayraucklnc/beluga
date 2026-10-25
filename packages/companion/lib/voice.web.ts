/** The web build has no on-device model: no microphone in the Ask sheet (lib/voice.ts). */
export type VoiceState = { kind: 'off' } | { kind: 'getting'; progress: number } | { kind: 'listening'; level: number } | { kind: 'writing' };

export const MODEL_MB = 57;
export const voiceAvailable = (): boolean => false;
export const modelReady = (): boolean => false;

export function useVoice(_onText: (words: string) => void): { state: VoiceState; start: () => Promise<void>; stop: () => void; cancel: () => void; error?: string } {
  return { state: { kind: 'off' }, start: async () => {}, stop: () => {}, cancel: () => {} };
}
