import type { ChipSound } from '../../../../../src/shared/notify-sound.js';
import { midi, type Note, type SoundSpec } from './synth.js';

/**
 * Klaud's 8-bit sounds: square, pulse, triangle and a little noise, like an old console, but
 * soft (gentle attack and release, low-passed) and short (none is longer than 0.8 s).
 */

const N = { C4: 60, G4: 67, C5: 72, D5: 74, E5: 76, G5: 79, A5: 81, B5: 83, C6: 84, D6: 86, E6: 88, G6: 91 } as const;

/** A run of notes, one after another. */
function run(notes: readonly number[], step: number, base: Omit<Note, 'at' | 'freq'>, last?: Partial<Note>): Note[] {
  return notes.map((m, i) => ({ ...base, at: i * step, freq: midi(m), ...(i === notes.length - 1 ? last : {}) }));
}

const SPECS: Readonly<Record<ChipSound, SoundSpec>> = {
  blip: {
    notes: [{ at: 0, dur: 0.11, freq: midi(N.A5), to: midi(N.E6), wave: 'pulse', gain: 0.8, release: 0.06 }],
    lowpass: 4200,
    maxLength: 0.2,
  },
  coin: {
    notes: [
      { at: 0, dur: 0.075, freq: midi(N.B5), wave: 'square', gain: 0.7, release: 0.02 },
      { at: 0.07, dur: 0.38, freq: midi(N.E6), wave: 'square', gain: 0.7, decay: 5, release: 0.2 },
    ],
    lowpass: 3800,
    maxLength: 0.5,
  },
  chime: {
    notes: [
      { at: 0, dur: 0.6, freq: midi(N.G5), wave: 'triangle', gain: 0.9, decay: 4, release: 0.3 },
      { at: 0.07, dur: 0.6, freq: midi(N.C6), wave: 'triangle', gain: 0.8, decay: 4, release: 0.3 },
      { at: 0.07, dur: 0.35, freq: midi(N.C6) * 2, wave: 'pulse', gain: 0.12, decay: 7, release: 0.2 },
    ],
    lowpass: 5000,
    maxLength: 0.75,
  },
  powerUp: {
    notes: [
      ...run([N.C5, N.E5, N.G5, N.C6, N.E6], 0.055, { dur: 0.07, wave: 'pulse', gain: 0.55, release: 0.03 }, { dur: 0.3, decay: 4, release: 0.18 }),
      { at: 0, dur: 0.5, freq: midi(N.C4), to: midi(N.C5), wave: 'triangle', gain: 0.5, release: 0.2 },
    ],
    lowpass: 4500,
    maxLength: 0.6,
  },
  arpUp: {
    notes: run([N.C5, N.E5, N.G5, N.C6], 0.075, { dur: 0.09, wave: 'square', gain: 0.55, release: 0.04 }, { dur: 0.32, decay: 4, release: 0.2 }),
    lowpass: 3600,
    maxLength: 0.62,
  },
  arpDown: {
    notes: run([N.C6, N.G5, N.E5, N.C5], 0.075, { dur: 0.09, wave: 'square', gain: 0.55, release: 0.04 }, { dur: 0.32, decay: 4, release: 0.2 }),
    lowpass: 3600,
    maxLength: 0.62,
  },
  ping: {
    notes: [
      { at: 0, dur: 0.22, freq: midi(N.E6), wave: 'triangle', gain: 0.9, decay: 6, release: 0.12 },
      { at: 0.13, dur: 0.45, freq: midi(N.C6), wave: 'triangle', gain: 0.9, decay: 5, release: 0.25 },
      { at: 0.13, dur: 0.2, freq: midi(N.C6), wave: 'pulse', gain: 0.1, decay: 9, release: 0.1 },
    ],
    lowpass: 4800,
    maxLength: 0.65,
  },
  done: {
    notes: [
      { at: 0, dur: 0.03, freq: 5200, wave: 'noise', gain: 0.18, release: 0.02 },
      ...run([N.G5, N.C6, N.D6, N.G6], 0.085, { dur: 0.1, wave: 'pulse', gain: 0.5, release: 0.04 }, { dur: 0.42, decay: 4, release: 0.25 }),
      { at: 0.255, dur: 0.45, freq: midi(N.G4), wave: 'triangle', gain: 0.55, decay: 3, release: 0.25 },
    ],
    lowpass: 4200,
    maxLength: 0.8,
  },
};

export const CHIP_LABELS: Readonly<Record<ChipSound, string>> = {
  blip: 'Blip',
  coin: 'Coin',
  chime: 'Chime',
  powerUp: 'Power-up',
  arpUp: 'Arpeggio up',
  arpDown: 'Arpeggio down',
  ping: 'Two-note ping',
  done: 'Done jingle',
};

export const chipSpec = (id: ChipSound): SoundSpec => SPECS[id];
