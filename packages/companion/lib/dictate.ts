/**
 * What the Ask sheet's microphone does with sound and words (lib/voice.ts), kept free of React and
 * native modules so it can be tested. The phone records 16 kHz mono 16-bit PCM, the on-device
 * Whisper model writes it down, and the words go into the field after what's already there.
 */

/** Whisper's sample rate: what the phone records at. */
export const SAMPLE_RATE = 16_000;
/** The longest one recording runs before it stops by itself (2 minutes). */
export const MAX_SECONDS = 120;
export const MAX_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;

/** Whisper's own notes on the sound, not words you said: [BLANK_AUDIO], (music), [ Silence ], ♪. */
const NOISE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g;

/** What Whisper wrote, as words for the field ('' when you said nothing). */
export function cleanTranscript(raw: string): string {
  return raw.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
}

/** The field after dictating: what was there, a space (or a new line after one), then the words. */
export function appendSpoken(field: string, spoken: string): string {
  const words = cleanTranscript(spoken);
  if (!words) return field;
  if (!field.trim()) return words;
  const sep = /\n\s*$/.test(field) ? '' : /\s$/.test(field) ? '' : ' ';
  return field + sep + words;
}

/** The recording so far, as one buffer, at most MAX_BYTES (an even number of bytes). */
export function joinPcm(chunks: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  n = Math.min(n, MAX_BYTES) & ~1;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    if (o >= n) break;
    const take = Math.min(c.length, n - o);
    out.set(take === c.length ? c : c.subarray(0, take), o);
    o += take;
  }
  return out;
}

/** How loud a chunk is, 0 (silence) to 1 (loud speech), for the microphone's pulse. */
export function pcmLevel(chunk: Uint8Array): number {
  const samples = chunk.length >> 1;
  if (!samples) return 0;
  const view = new DataView(chunk.buffer, chunk.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  // Speech sits around an RMS of 0.02 to 0.2; a square root spreads that over the range.
  return Math.min(1, Math.sqrt(Math.sqrt(sum / samples) / 0.2));
}

/** The recording as a WAV file (16 kHz mono 16-bit), as the Mac takes it (companion.transcribe). */
export function wavOf(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
