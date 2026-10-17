/**
 * Terminal color tables. xterm reports colors either as a palette index
 * (0-255) or as a packed 0xRRGGBB truecolor value; the UI wants `#rrggbb`.
 */

/** A muted xterm-like 16 color palette (ANSI 0-7, then bright 8-15). */
export const DEFAULT_PALETTE: readonly string[] = [
  '#1e1e1e', // black
  '#e06c75', // red
  '#98c379', // green
  '#e5c07b', // yellow
  '#61afef', // blue
  '#c678dd', // magenta
  '#56b6c2', // cyan
  '#d0d0d0', // white
  '#5c6370', // bright black
  '#ff7a85', // bright red
  '#b5e890', // bright green
  '#ffd88a', // bright yellow
  '#7ec3ff', // bright blue
  '#de9bf0', // bright magenta
  '#7fd4de', // bright cyan
  '#ffffff', // bright white
];

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

export const rgbToHex = (packed: number): string => `#${(packed & 0xffffff).toString(16).padStart(6, '0')}`;

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/**
 * Build the full 256 color table: the 16 base colors from `palette`
 * (falling back to the default for missing/invalid entries), the 6x6x6
 * color cube and the 24 step grayscale ramp.
 */
export function buildColorTable(palette: readonly string[] = DEFAULT_PALETTE): readonly string[] {
  const table: string[] = [];
  for (let i = 0; i < 16; i++) {
    const given = palette[i];
    table.push(given && /^#[0-9a-f]{6}$/i.test(given) ? given.toLowerCase() : (DEFAULT_PALETTE[i] as string));
  }
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        table.push(`#${hex2(CUBE_STEPS[r] as number)}${hex2(CUBE_STEPS[g] as number)}${hex2(CUBE_STEPS[b] as number)}`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    table.push(`#${hex2(v)}${hex2(v)}${hex2(v)}`);
  }
  return table;
}
