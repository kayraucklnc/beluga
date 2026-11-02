/**
 * The pixel-art burst's motion (PixelBurst.tsx draws it), without React or a canvas, so the tests
 * can fly every piece to its furthest and check it never leaves the canvas: a coin cut off at
 * the top, or a square at the side, would show the canvas's edge.
 */

/** One art pixel, in CSS pixels. */
export const PX = 3;
/** The canvas, in art pixels: room for the highest coin and the widest, lowest square. */
export const W = 92;
export const H = 58;
/** Where the amount sits on it: most of the room is above, where the coins hop. */
export const FROM_Y = 38;
export const FPS = 15;
export const FRAMES = 22;
const GRAVITY = 0.2;
const COIN_GRAVITY = 0.16;
/** The widest the pieces start apart (about a compact amount, "$20.7K"). */
const SPREAD = 18;
const PIECES = 26;
const COINS = 3;

/** Pastels with enough colour to read on a light sidebar (and a dark one). */
const COLORS = ['#f4a6b4', '#f7c28a', '#f2d974', '#8fd3a8', '#8cc7ea', '#b4a6ee', '#f0a8d8'];
const GOLD = '#e8bf4f';
const GOLD_LIGHT = '#f8e3a0';
/** A coin, 4×4 around its middle: an outline in gold, a light middle. */
const COIN = ['.##.', '#++#', '#++#', '.##.'];

export interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  /** The frame it blinks out on. */
  dies: number;
  coin: boolean;
}

/** One piece leaving the amount (`width`: the amount's, in CSS pixels). */
export function piece(coin: boolean, width: number, rand: () => number = Math.random): Piece {
  const spread = Math.max(4, Math.min(SPREAD, width / PX));
  return {
    x: W / 2 + (rand() - 0.5) * spread,
    y: FROM_Y,
    vx: (rand() - 0.5) * (coin ? 1.6 : 3.2),
    vy: -(coin ? 2.6 + rand() * 0.8 : 1.4 + rand() * 2),
    size: coin ? 4 : rand() < 0.3 ? 2 : 1,
    color: COLORS[Math.floor(rand() * COLORS.length)]!,
    // Coins stay to the end; squares go one by one from halfway.
    dies: coin ? FRAMES - 2 + Math.floor(rand() * 3) : 11 + Math.floor(rand() * (FRAMES - 11)),
    coin,
  };
}

export function burst(width: number, rand: () => number = Math.random): Piece[] {
  return [...Array.from({ length: PIECES }, () => piece(false, width, rand)), ...Array.from({ length: COINS }, () => piece(true, width, rand))];
}

/** One frame on: gravity, then a move. */
export function step(pieces: readonly Piece[]): void {
  for (const p of pieces) {
    p.vy += p.coin ? COIN_GRAVITY : GRAVITY;
    p.x += p.vx;
    p.y += p.vy;
  }
}

/** The art pixels a piece shows on `frame`: none once it's gone, and in its last three it blinks. */
export function pixels(p: Piece, frame: number): Array<{ x: number; y: number; color: string }> {
  if (frame >= p.dies || (p.dies - frame <= 3 && (p.dies - frame) % 2 === 0)) return [];
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (!p.coin) {
    const out: Array<{ x: number; y: number; color: string }> = [];
    for (let dy = 0; dy < p.size; dy++) for (let dx = 0; dx < p.size; dx++) out.push({ x: x + dx, y: y + dy, color: p.color });
    return out;
  }
  return COIN.flatMap((row, dy) => [...row].flatMap((c, dx) => (c === '.' ? [] : [{ x: x + dx - 2, y: y + dy - 2, color: c === '#' ? GOLD : GOLD_LIGHT }])));
}
