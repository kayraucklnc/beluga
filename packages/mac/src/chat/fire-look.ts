/**
 * How Max effort's fire looks (Settings › Max Fire): a preset sets everything; the sliders and
 * colours fine-tune it (and make it your own). Kept on this Mac, with the window's other prefs.
 */

export type FlameStyle = 'toon' | 'pixel';
/** When it burns on Max: whenever the box is showing, only while you type, or never. */
export type FireShow = 'always' | 'typing' | 'off';

export interface FirePalette {
  readonly id: string;
  readonly name: string;
  /** Edge, middle, core. */
  readonly colors: readonly [string, string, string];
}

export interface FireLook {
  readonly show: FireShow;
  readonly style: FlameStyle;
  /** 0–1 each. Fuel: how many flames; height: how tall they climb; thickness: how fat; wildness: how much they lick and dance. */
  readonly fuel: number;
  readonly height: number;
  readonly thickness: number;
  readonly wildness: number;
  /** A palette's id (one of PALETTES or of `palettes`, your own). */
  readonly palette: string;
  /** Typing fast makes it flare orange, like Hades losing his temper. */
  readonly temper: boolean;
  /** Confetti from the caret as you type. */
  readonly confetti: boolean;
  /** What you delete pops into pixels. */
  readonly popDelete: boolean;
  /** The preset it matches, or 'custom' once you've changed something. */
  readonly preset: string;
  /** Colours you made and named. */
  readonly palettes: readonly FirePalette[];
}

export const PALETTES: readonly FirePalette[] = [
  { id: 'blue', name: 'Blue', colors: ['#2346c8', '#3fa2ff', '#d4f6ff'] },
  { id: 'red', name: 'Red', colors: ['#8f1022', '#e0293b', '#ff9a8a'] },
  { id: 'rose', name: 'Rose', colors: ['#b8336a', '#f27aa6', '#ffe1ec'] },
  { id: 'ember', name: 'Ember', colors: ['#c2261a', '#ff7a1f', '#ffd84a'] },
  { id: 'gold', name: 'Gold', colors: ['#b45309', '#f5b82e', '#fff3c4'] },
  { id: 'venom', name: 'Venom', colors: ['#166534', '#3fd47a', '#e0fbe9'] },
  { id: 'violet', name: 'Violet', colors: ['#5b21b6', '#a78bfa', '#efe9ff'] },
];

/** What typing fast flares to. */
export const TEMPER: readonly [string, string, string] = ['#d8361c', '#ff8a1f', '#ffe35a'];

type Tuning = Pick<FireLook, 'style' | 'fuel' | 'height' | 'thickness' | 'wildness' | 'palette' | 'temper'>;

export const PRESETS: ReadonlyArray<{ readonly id: string; readonly name: string; readonly blurb: string; readonly look: Tuning }> = [
  { id: 'hades', name: 'Hades', blurb: 'Blue, lively, flares when you rush', look: { style: 'toon', fuel: 0.55, height: 0.5, thickness: 0.5, wildness: 0.55, palette: 'blue', temper: true } },
  { id: 'candle', name: 'Candle', blurb: 'A few calm, gold tips', look: { style: 'toon', fuel: 0.2, height: 0.3, thickness: 0.3, wildness: 0.15, palette: 'gold', temper: false } },
  { id: 'bonfire', name: 'Bonfire', blurb: 'Tall, thick and wild', look: { style: 'toon', fuel: 0.9, height: 0.9, thickness: 0.75, wildness: 0.75, palette: 'ember', temper: false } },
  { id: 'rose', name: 'Rose Garden', blurb: 'Soft pink, gently swaying', look: { style: 'toon', fuel: 0.45, height: 0.45, thickness: 0.6, wildness: 0.3, palette: 'rose', temper: false } },
  { id: 'arcade', name: 'Arcade', blurb: 'Pixel fire, like an old game', look: { style: 'pixel', fuel: 0.6, height: 0.55, thickness: 0.55, wildness: 0.5, palette: 'red', temper: true } },
];

export const DEFAULT_FIRE: FireLook = { show: 'always', ...PRESETS[0]!.look, confetti: true, popDelete: true, preset: 'hades', palettes: [] };

/** A palette by id: yours first, then the built-in ones (Blue if it's gone). */
export const paletteOf = (look: Pick<FireLook, 'palette' | 'palettes'>): FirePalette => look.palettes.find((p) => p.id === look.palette) ?? PALETTES.find((p) => p.id === look.palette) ?? PALETTES[0]!;

/** The preset these settings are exactly, if any. */
export function presetOf(look: FireLook): string {
  const same = PRESETS.find((p) => (Object.keys(p.look) as Array<keyof Tuning>).every((k) => look[k] === p.look[k]));
  return same?.id ?? 'custom';
}

/** Saved settings, made whole (older or partial ones get the defaults). */
export function fireLookOf(saved: unknown): FireLook {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<FireLook>;
  const unit = (v: unknown, d: number): number => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
  return {
    show: s.show === 'typing' || s.show === 'off' ? s.show : 'always',
    style: s.style === 'pixel' ? 'pixel' : 'toon',
    fuel: unit(s.fuel, DEFAULT_FIRE.fuel),
    height: unit(s.height, DEFAULT_FIRE.height),
    thickness: unit(s.thickness, DEFAULT_FIRE.thickness),
    wildness: unit(s.wildness, DEFAULT_FIRE.wildness),
    palette: typeof s.palette === 'string' ? s.palette : DEFAULT_FIRE.palette,
    temper: typeof s.temper === 'boolean' ? s.temper : DEFAULT_FIRE.temper,
    confetti: typeof s.confetti === 'boolean' ? s.confetti : DEFAULT_FIRE.confetti,
    popDelete: typeof s.popDelete === 'boolean' ? s.popDelete : DEFAULT_FIRE.popDelete,
    preset: typeof s.preset === 'string' ? s.preset : DEFAULT_FIRE.preset,
    palettes: Array.isArray(s.palettes) ? s.palettes.filter((p): p is FirePalette => Boolean(p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.colors) && p.colors.length === 3)) : [],
  };
}

/** How far the fire can reach above the box (CSS px), so it's never cut off. */
export const reachOf = (look: Pick<FireLook, 'height' | 'thickness'>): number => Math.round(48 + look.height * 120 + look.thickness * 24);

/** The look's colours as CSS variables (the rim, the send button and the Max tag use them). */
export const fireVars = (look: Pick<FireLook, 'palette' | 'palettes'>): Record<string, string> => {
  const [f0, f1, f2] = paletteOf(look).colors;
  return { '--f0': f0, '--f1': f1, '--f2': f2 };
};
