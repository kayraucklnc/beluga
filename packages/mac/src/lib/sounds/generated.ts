import { midi, type Note, type SoundSpec } from './synth.js';

/**
 * Sounds made from a number (the seed): a short pentatonic motif, 2–4 notes, played by a soft
 * FM bell or a sine with a little room around it. The same seed is always the same sound, and
 * there are four billion of them, so yours is yours.
 */

/** A small, fast, good-enough random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PENTATONIC = [0, 2, 4, 7, 9] as const;
/** Bell timbres: carrier:modulator ratios that ring sweetly (whole numbers) or like glass (3.5, 1.4). */
const RATIOS = [1, 2, 3, 3.5, 4, 1.4] as const;

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;

/** The motif: scale degrees that move by small steps and come home at the end. */
function melody(r: () => number, count: number): number[] {
  const degrees: number[] = [Math.floor(r() * 5)];
  for (let i = 1; i < count; i++) {
    const prev = degrees[i - 1]!;
    const step = pick(r, [-2, -1, 1, 1, 2, 2, 3]);
    degrees.push(Math.max(0, Math.min(9, prev + step)));
  }
  // End on the root or the fifth (degree 0, 3, 5 or 8 of the two-octave pentatonic): it sounds finished.
  const last = degrees[count - 1]!;
  degrees[count - 1] = [0, 3, 5, 8].reduce((best, d) => (Math.abs(d - last) < Math.abs(best - last) ? d : best), 5);
  return degrees;
}

export function generatedSpec(seed: number): SoundSpec {
  const r = rng(seed);
  const root = 72 + Math.floor(r() * 8); // C5 to G5
  const count = 2 + Math.floor(r() * 3);
  const step = 0.08 + r() * 0.08;
  const bell = r() < 0.75;
  const ratio = pick(r, RATIOS);
  const index = 0.6 + r() * 1.8;
  const ring = 0.3 + r() * 0.35;
  const degrees = melody(r, count);
  const notes: Note[] = degrees.map((d, i) => {
    const pitch = root + 12 * Math.floor(d / 5) + PENTATONIC[d % 5]!;
    const lastOne = i === count - 1;
    const dur = lastOne ? ring + 0.15 : Math.min(ring, step * 2.2);
    return {
      at: i * step,
      dur,
      freq: midi(pitch),
      wave: bell ? 'fm' : 'sine',
      gain: lastOne ? 0.9 : 0.7,
      attack: 0.004,
      release: dur * 0.6,
      decay: 2.5 / ring,
      ...(bell ? { fm: { ratio, index, fade: 5 + r() * 6 } } : {}),
    };
  });
  return {
    notes,
    lowpass: 5200 + r() * 2000,
    reverb: { mix: 0.15 + r() * 0.2, time: 0.5 + r() * 0.5 },
    maxLength: 1.4,
  };
}

const ADJECTIVES = ['Soft', 'Amber', 'Velvet', 'Misty', 'Golden', 'Quiet', 'Bright', 'Hollow', 'Silver', 'Warm', 'Glassy', 'Lunar', 'Morning', 'Paper', 'Copper', 'Willow'] as const;
const NOUNS = ['Bell', 'Drop', 'Bloom', 'Spark', 'Ripple', 'Lantern', 'Pebble', 'Breeze', 'Echo', 'Feather', 'Comet', 'Petal', 'Chime', 'Glow', 'Wave', 'Dew'] as const;

/** A name to tell your generated sounds apart ("Amber Ripple"), from the seed. */
export function generatedName(seed: number): string {
  const r = rng(seed ^ 0x5bd1e995);
  return `${pick(r, ADJECTIVES)} ${pick(r, NOUNS)}`;
}

/** A new seed nobody else is likely to have. */
export function randomSeed(): number {
  const one = new Uint32Array(1);
  globalThis.crypto.getRandomValues(one);
  return one[0]!;
}
