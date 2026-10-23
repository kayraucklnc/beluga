import { CHIP_SOUNDS, MAC_SOUNDS, SOUND_GROUPS, type SoundChoice, type SoundPrefs, coerceSound, soundFor, volumeOf } from '../../../../../src/shared/notify-sound.js';
import { CHIP_LABELS, chipSpec } from './chip.js';
import { generatedName, generatedSpec } from './generated.js';
import { render, SAMPLE_RATE } from './synth.js';

/** Everything you can pick, with names, for Settings › Notifications. */

export type SoundFamily = SoundChoice['kind'];

export const FAMILY_LABELS: Readonly<Record<SoundFamily, string>> = { chip: '8-bit', gen: 'Generated', mac: 'Mac', none: 'None' };

/** "Coin", "Amber Ripple", "Glass", "None". */
export function soundName(choice: SoundChoice): string {
  switch (choice.kind) {
    case 'none':
      return 'None';
    case 'mac':
      return choice.id;
    case 'chip':
      return CHIP_LABELS[choice.id];
    case 'gen':
      return generatedName(choice.seed);
  }
}

/** "8-bit · Coin": the name with where it's from. */
export const soundTitle = (choice: SoundChoice): string => (choice.kind === 'none' || choice.kind === 'mac' ? soundName(choice) : `${FAMILY_LABELS[choice.kind]} · ${soundName(choice)}`);

/** Whether Beluga makes this sound itself (and the volume slider applies). */
export const belugaMade = (choice: SoundChoice): choice is Extract<SoundChoice, { kind: 'chip' | 'gen' }> => choice.kind === 'chip' || choice.kind === 'gen';

/** The samples of one of Beluga's sounds at `volume` (`null`: macOS plays it, or there's none). */
export function renderChoice(choice: SoundChoice, volume: number, rate = SAMPLE_RATE): Float32Array<ArrayBuffer> | null {
  if (choice.kind === 'chip') return render(chipSpec(choice.id), volume, rate);
  if (choice.kind === 'gen') return render(generatedSpec(choice.seed), volume, rate);
  return null;
}

/**
 * The file name macOS finds it by in ~/Library/Sounds (`Beluga-chip-coin-70`). The volume is
 * part of the name: a sound at a new volume is a new file (the old one is pruned).
 */
export function soundFileName(choice: SoundChoice, volume: number): string | null {
  const pct = Math.round(Math.min(1, Math.max(0, volume)) * 100);
  if (choice.kind === 'chip') return `Beluga-chip-${choice.id.toLowerCase()}-${pct}`;
  if (choice.kind === 'gen') return `Beluga-gen-${choice.seed.toString(16).padStart(8, '0')}-${pct}`;
  return null;
}

/** Every sound the settings use (the main one, and each kind's when they differ). */
export function soundsInUse(prefs: SoundPrefs): SoundChoice[] {
  const all = [coerceSound(prefs.sound), ...(prefs.perKind ? SOUND_GROUPS.map((g) => soundFor(prefs, g)) : [])];
  return all.filter((c, i) => all.findIndex((o) => JSON.stringify(o) === JSON.stringify(c)) === i);
}

/** The ~/Library/Sounds files the settings need (everything else of Beluga's there can go). */
export const filesInUse = (prefs: SoundPrefs): string[] => soundsInUse(prefs).flatMap((c) => soundFileName(c, volumeOf(prefs)) ?? []);

export const CHIP_CHOICES: readonly SoundChoice[] = CHIP_SOUNDS.map((id) => ({ kind: 'chip', id }));
export const MAC_CHOICES: readonly SoundChoice[] = MAC_SOUNDS.map((id) => ({ kind: 'mac', id }));

/** A stable key for a choice (React keys, <option> values). */
export const choiceKey = (c: SoundChoice): string => (c.kind === 'none' ? 'none' : c.kind === 'gen' ? `gen:${c.seed}` : `${c.kind}:${c.id}`);

/** The choice a key stands for (`null` if it isn't one). */
export function choiceFromKey(key: string): SoundChoice | null {
  if (key === 'none') return { kind: 'none' };
  const [kind, rest = ''] = key.split(':');
  const parsed = coerceSound(kind === 'gen' ? { kind, seed: Number(rest) } : { kind, id: rest });
  return choiceKey(parsed) === key ? parsed : null;
}
