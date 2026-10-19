import { describe, expect, it } from 'vitest';
import { CHIP_SOUNDS, NO_SOUND } from '../src/shared/notify-sound.js';
import { CHIP_LABELS, chipSpec } from '../packages/mac/src/lib/sounds/chip.js';
import { CHIP_CHOICES, MAC_CHOICES, choiceFromKey, choiceKey, filesInUse, klaudMade, renderChoice, soundFileName, soundName, soundTitle, soundsInUse } from '../packages/mac/src/lib/sounds/catalog.js';
import { generatedName, generatedSpec, randomSeed, rng } from '../packages/mac/src/lib/sounds/generated.js';
import { LOUDNESS, PEAK, SAMPLE_RATE, midi, render } from '../packages/mac/src/lib/sounds/synth.js';
import { encodeWav } from '../packages/mac/src/lib/sounds/wav.js';

/**
 * The Mac app's notification sounds (packages/mac/src/lib/sounds): made from notes, the same
 * every time, short, never clipping, soft at the edges, and saved as files macOS can play.
 * (Writing them to ~/Library/Sounds is tested in the app shell: src-tauri/src/sounds.rs.)
 */

const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const mean = (x: Float32Array): number => x.reduce((s, v) => s + v, 0) / x.length;
/** How much of it is high frequencies (RMS of the slope over RMS): a harsh buzz scores high. */
const brightness = (x: Float32Array): number => {
  let e = 0;
  let d = 0;
  for (let i = 1; i < x.length; i++) {
    e += x[i]! * x[i]!;
    d += (x[i]! - x[i - 1]!) ** 2;
  }
  return Math.sqrt(d / e);
};
const SEEDS = [0, 1, 2, 42, 123_456, 0xdeadbeef, 0xffffffff];

describe('8-bit sounds', () => {
  it.each(CHIP_SOUNDS)('%s is short, soft at the edges, and never clips', (id) => {
    const x = render(chipSpec(id), 1);
    expect(x.length / SAMPLE_RATE).toBeGreaterThan(0.08);
    expect(x.length / SAMPLE_RATE).toBeLessThanOrEqual(0.8);
    expect(peak(x)).toBeLessThanOrEqual(PEAK + 1e-6);
    expect(peak(x)).toBeGreaterThan(0.1);
    expect(Math.abs(x[0]!)).toBeLessThan(0.01);
    expect(Math.abs(x[x.length - 1]!)).toBe(0);
    expect(Math.abs(mean(x))).toBeLessThan(0.01);
    expect(brightness(x)).toBeLessThan(0.3);
    expect(x.every(Number.isFinite)).toBe(true);
  });

  it('are the same every time, and each one is different', () => {
    expect(render(chipSpec('coin'))).toEqual(render(chipSpec('coin')));
    const all = CHIP_SOUNDS.map((id) => render(chipSpec(id)).slice(0, 2000).join());
    expect(new Set(all).size).toBe(CHIP_SOUNDS.length);
    expect(Object.keys(CHIP_LABELS)).toEqual([...CHIP_SOUNDS]);
  });

  it('scale with the volume, and are silent at zero', () => {
    const full = render(chipSpec('chime'), 1);
    const half = render(chipSpec('chime'), 0.5);
    expect(peak(half)).toBeCloseTo(peak(full) / 2, 5);
    expect(peak(render(chipSpec('chime'), 0))).toBe(0);
  });

  it('are about as loud as each other (a dense blip is turned down)', () => {
    const loudest = (x: Float32Array): number => {
      let best = 0;
      for (let s = 0; s < x.length; s += 512) {
        let sum = 0;
        for (let i = s; i < Math.min(x.length, s + 2205); i++) sum += x[i]! * x[i]!;
        best = Math.max(best, Math.sqrt(sum / 2205));
      }
      return best;
    };
    for (const id of CHIP_SOUNDS) expect(loudest(render(chipSpec(id), 1))).toBeLessThanOrEqual(LOUDNESS + 0.01);
  });
});

describe('generated sounds', () => {
  it('are the same for the same seed and differ between seeds', () => {
    expect(render(generatedSpec(42))).toEqual(render(generatedSpec(42)));
    expect(generatedName(42)).toBe(generatedName(42));
    const sounds = SEEDS.map((s) => render(generatedSpec(s)).slice(0, 4000).join());
    expect(new Set(sounds).size).toBe(SEEDS.length);
  });

  it.each(SEEDS)('seed %i: a 2–4 note pentatonic motif with a short tail', (seed) => {
    const spec = generatedSpec(seed);
    expect(spec.notes.length).toBeGreaterThanOrEqual(2);
    expect(spec.notes.length).toBeLessThanOrEqual(4);
    const pitches = spec.notes.map((n) => Math.round(12 * Math.log2(n.freq / 440) + 69));
    // Every note is on the major pentatonic of some root between C5 and G5.
    const fits = [72, 73, 74, 75, 76, 77, 78, 79].some((r) => pitches.every((p) => [0, 2, 4, 7, 9].includes((((p - r) % 12) + 12) % 12)));
    expect(fits).toBe(true);
    const x = render(spec, 1);
    expect(x.length / SAMPLE_RATE).toBeLessThanOrEqual(1.4);
    expect(peak(x)).toBeLessThanOrEqual(PEAK + 1e-6);
    expect(peak(x)).toBeGreaterThan(0.1);
    expect(Math.abs(x[x.length - 1]!)).toBe(0);
    expect(brightness(x)).toBeLessThan(0.45);
  });

  it('have names, and new seeds are random', () => {
    expect(generatedName(7)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const seeds = new Set(Array.from({ length: 20 }, randomSeed));
    expect(seeds.size).toBe(20);
    for (const s of seeds) expect(s).toBeGreaterThanOrEqual(0);
    const r = rng(1);
    expect(r()).toBe(rng(1)());
  });
});

describe('WAV files', () => {
  it('are 16-bit mono PCM with a correct header', () => {
    const x = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
    const wav = encodeWav(x, 22_050);
    const v = new DataView(wav.buffer);
    const text = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect(wav.length).toBe(44 + x.length * 2);
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(22_050);
    expect(v.getUint32(28, true)).toBe(44_100);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(x.length * 2);
    const samples = Array.from({ length: x.length }, (_, i) => v.getInt16(44 + i * 2, true));
    // Clamped at full scale.
    expect(samples).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
  });

  it('hold a whole rendered sound', () => {
    const x = render(chipSpec('coin'));
    expect(encodeWav(x, SAMPLE_RATE).length).toBe(44 + x.length * 2);
  });
});

describe('the sound catalog', () => {
  const gen = { kind: 'gen', seed: 0xa1b2c3 } as const;

  it('names every sound', () => {
    expect(soundName({ kind: 'chip', id: 'powerUp' })).toBe('Power-up');
    expect(soundTitle({ kind: 'chip', id: 'coin' })).toBe('8-bit · Coin');
    expect(soundTitle({ kind: 'mac', id: 'Glass' })).toBe('Glass');
    expect(soundTitle(gen)).toBe(`Generated · ${generatedName(0xa1b2c3)}`);
    expect(soundTitle(NO_SOUND)).toBe('None');
    expect(MAC_CHOICES).toHaveLength(14);
    expect(CHIP_CHOICES).toHaveLength(8);
  });

  it('gives Klaud’s sounds file names the app shell accepts (Klaud-[a-z0-9-])', () => {
    for (const c of [...CHIP_CHOICES, gen, { kind: 'gen', seed: 0 } as const, { kind: 'gen', seed: 0xffffffff } as const]) {
      expect(soundFileName(c, 0.7)).toMatch(/^Klaud-[a-z0-9-]{1,48}$/);
    }
    expect(soundFileName({ kind: 'chip', id: 'powerUp' }, 0.7)).toBe('Klaud-chip-powerup-70');
    expect(soundFileName(gen, 1)).toBe('Klaud-gen-00a1b2c3-100');
    expect(soundFileName({ kind: 'mac', id: 'Glass' }, 0.7)).toBeNull();
    expect(renderChoice({ kind: 'mac', id: 'Glass' }, 1)).toBeNull();
    expect(renderChoice(NO_SOUND, 1)).toBeNull();
    expect(klaudMade(gen)).toBe(true);
    expect(klaudMade(NO_SOUND)).toBe(false);
  });

  it('knows which files the settings need (per kind too, each once)', () => {
    const prefs = { sound: { kind: 'chip', id: 'coin' }, soundVolume: 0.5, perKind: { needsYou: gen, done: { kind: 'mac', id: 'Purr' }, people: gen } };
    expect(soundsInUse(prefs)).toHaveLength(3);
    expect(filesInUse(prefs).sort()).toEqual(['Klaud-chip-coin-50', 'Klaud-gen-00a1b2c3-50']);
    expect(filesInUse({ sound: false })).toEqual([]);
  });

  it('round-trips choices through keys', () => {
    for (const c of [...CHIP_CHOICES, ...MAC_CHOICES, gen, NO_SOUND]) expect(choiceFromKey(choiceKey(c))).toEqual(c);
    expect(choiceFromKey('mac:Nope')).toBeNull();
    expect(choiceFromKey('gen:abc')).toBeNull();
  });

  it('tunes notes to concert pitch', () => {
    expect(midi(69)).toBe(440);
    expect(midi(81)).toBeCloseTo(880, 6);
  });
});
