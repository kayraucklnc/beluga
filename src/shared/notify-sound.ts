import { z } from 'zod';

// Which sound a notification makes (Settings › Notifications). Data only, shared by the daemon,
// the Mac app (which plays all of them) and the terminal app (which plays what it can).

/** The sounds macOS ships in /System/Library/Sounds. */
export const MAC_SOUNDS = ['Glass', 'Ping', 'Pop', 'Purr', 'Tink', 'Hero', 'Funk', 'Submarine', 'Blow', 'Bottle', 'Frog', 'Morse', 'Sosumi', 'Basso'] as const;
export type MacSound = (typeof MAC_SOUNDS)[number];

/** Beluga's own 8-bit sounds (made by packages/mac/src/lib/sounds/chip.ts). */
export const CHIP_SOUNDS = ['blip', 'coin', 'chime', 'powerUp', 'arpUp', 'arpDown', 'ping', 'done'] as const;
export type ChipSound = (typeof CHIP_SOUNDS)[number];

const SEED = z.number().int().min(0).max(0xffffffff);

/** One sound: none, a Mac sound, a Beluga 8-bit sound, or one generated from a seed. */
export const SoundChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('mac'), id: z.enum(MAC_SOUNDS) }),
  z.object({ kind: z.literal('chip'), id: z.enum(CHIP_SOUNDS) }),
  z.object({ kind: z.literal('gen'), seed: SEED }),
]);
export type SoundChoice = z.infer<typeof SoundChoice>;

export const NO_SOUND: SoundChoice = { kind: 'none' };
export const DEFAULT_SOUND: SoundChoice = { kind: 'mac', id: 'Glass' };
export const DEFAULT_VOLUME = 0.7;

/**
 * A saved sound as it is now: the old on/off switch (`true`/`false`) becomes the default sound
 * or none; anything unreadable becomes the default rather than costing you your other settings.
 */
export function coerceSound(raw: unknown): SoundChoice {
  if (raw === false) return NO_SOUND;
  const parsed = SoundChoice.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_SOUND;
}

/** The kinds of notification that can each have their own sound. */
export const SOUND_GROUPS = ['needsYou', 'done', 'mentions', 'people', 'background'] as const;
export type SoundGroup = (typeof SOUND_GROUPS)[number];

/** Per-kind sounds (`null`: the same sound for all). */
export const PerKindSounds = z.object({
  needsYou: SoundChoice,
  done: SoundChoice,
  mentions: SoundChoice,
  people: SoundChoice,
  background: SoundChoice,
});
export type PerKindSounds = z.infer<typeof PerKindSounds>;

/** Saved per-kind sounds, keeping the readable ones (`null`: the same sound for all). */
export function coercePerKind(raw: unknown): Partial<PerKindSounds> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const kept = SOUND_GROUPS.flatMap((g) => {
    const parsed = SoundChoice.safeParse(fields[g]);
    return parsed.success ? [[g, parsed.data] as const] : [];
  });
  return Object.fromEntries(kept);
}

/** The notification kinds (core/notify.ts NoticeKind) and whose sound each one makes. */
const GROUP_OF: Readonly<Record<string, SoundGroup>> = {
  needsYou: 'needsYou',
  done: 'done',
  problems: 'done',
  mentions: 'mentions',
  people: 'people',
  background: 'background',
  pr: 'background',
};

export const soundGroupOf = (kind: string): SoundGroup => GROUP_OF[kind] ?? 'done';

/** What the sound settings look like (a subset of NotifySettings, possibly from old settings). */
export interface SoundPrefs {
  readonly sound: unknown;
  readonly soundVolume?: number;
  readonly perKind?: Partial<Record<SoundGroup, unknown>> | null;
}

/** The sound a notification of this kind makes. */
export function soundFor(prefs: SoundPrefs, kind: string): SoundChoice {
  const own = prefs.perKind?.[soundGroupOf(kind)];
  return own === undefined ? coerceSound(prefs.sound) : coerceSound(own);
}

/** For a burst of several kinds, the one whose sound plays: what needs you first. */
export function loudestKind(kinds: readonly string[]): string {
  const rank = (k: string): number => SOUND_GROUPS.indexOf(soundGroupOf(k));
  return [...kinds].sort((a, b) => rank(a) - rank(b))[0] ?? 'done';
}

export const volumeOf = (prefs: SoundPrefs): number => {
  const v = prefs.soundVolume;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
};

/** Whether notifications make any sound at all. */
export function soundOn(prefs: SoundPrefs): boolean {
  if (prefs.perKind) return SOUND_GROUPS.some((g) => soundFor(prefs, g).kind !== 'none');
  return coerceSound(prefs.sound).kind !== 'none';
}

/** The on/off switch of the terminal app: off is no sound anywhere; on is the default sound. */
export function toggledSound(prefs: SoundPrefs): { sound: SoundChoice; perKind: null } {
  return { sound: soundOn(prefs) ? NO_SOUND : DEFAULT_SOUND, perKind: null };
}

export const sameSound = (a: SoundChoice, b: SoundChoice): boolean => JSON.stringify(a) === JSON.stringify(b);
