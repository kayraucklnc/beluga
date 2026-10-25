import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from '../lib/reduced-motion.js';

/**
 * A new payment: a small burst of pixel-art confetti from an amount (the sidebar's), drawn on a
 * tiny canvas scaled up with crisp pixels and moved a frame at a time, like a sprite. Soft
 * pastel squares, a few gold coins that hop higher, pieces that blink out rather than fade. No
 * glow. Over the window (never clipped by the sidebar), it never takes a click and clears itself
 * in about a second and a half. With less motion asked for there is none.
 */

/** One art pixel, in CSS pixels. */
const PX = 3;
/** The canvas, in art pixels: wide and tall enough for the pieces to fly out of the amount. */
const W = 56;
const H = 34;
/** Where the amount sits on it. */
const FROM_Y = H - 9;
const FPS = 15;
const FRAMES = 22;
const GRAVITY = 0.2;
const PIECES = 26;
const COINS = 3;

/** Pastels with enough colour to read on a light sidebar (and a dark one). */
const COLORS = ['#f4a6b4', '#f7c28a', '#f2d974', '#8fd3a8', '#8cc7ea', '#b4a6ee', '#f0a8d8'];
const GOLD = '#e8bf4f';
const GOLD_LIGHT = '#f8e3a0';

/** A coin, 4×4: an outline in gold, a light middle. */
const COIN = ['.##.', '#++#', '#++#', '.##.'];

interface Piece {
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

function burst(width: number): Piece[] {
  const spread = Math.max(4, Math.min(W - 8, width / PX));
  const piece = (coin: boolean): Piece => ({
    x: W / 2 + (Math.random() - 0.5) * spread,
    y: FROM_Y,
    vx: (Math.random() - 0.5) * (coin ? 1.6 : 3.2),
    vy: -(coin ? 2.6 + Math.random() * 0.8 : 1.4 + Math.random() * 2),
    size: coin ? 4 : Math.random() < 0.3 ? 2 : 1,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    dies: coin ? FRAMES - 2 + Math.floor(Math.random() * 3) : 11 + Math.floor(Math.random() * (FRAMES - 11)),
    coin,
  });
  return [...Array.from({ length: PIECES }, () => piece(false)), ...Array.from({ length: COINS }, () => piece(true))];
}

function draw(ctx: CanvasRenderingContext2D, pieces: readonly Piece[], frame: number): void {
  ctx.clearRect(0, 0, W, H);
  for (const p of pieces) {
    if (frame >= p.dies) continue;
    // The last three frames it blinks: there, gone, there.
    if (p.dies - frame <= 3 && (p.dies - frame) % 2 === 0) continue;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (!p.coin) {
      ctx.fillStyle = p.color;
      ctx.fillRect(x, y, p.size, p.size);
      continue;
    }
    COIN.forEach((row, dy) => {
      [...row].forEach((c, dx) => {
        if (c === '.') return;
        ctx.fillStyle = c === '#' ? GOLD : GOLD_LIGHT;
        ctx.fillRect(x + dx - 2, y + dy - 2, 1, 1);
      });
    });
  }
}

/** The burst over `anchor`, once; `onDone` when it has cleared. */
export function PixelBurst({ anchor, onDone }: { anchor: HTMLElement | null; onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  // Where the amount is now (the sidebar doesn't move while it plays).
  const [box] = useState(() => anchor?.getBoundingClientRect());
  const shown = Boolean(box && box.width > 0 && box.height > 0) && !reducedMotion();
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!shown || !ctx || !box) return done.current();
    ctx.imageSmoothingEnabled = false;
    const pieces = burst(box.width);
    const start = performance.now();
    let frame = 0;
    let raf = 0;
    draw(ctx, pieces, frame);
    // Stepped: the pieces move only on the sprite's own frames, FPS a second.
    const tick = (now: number): void => {
      const due = Math.min(FRAMES, Math.floor(((now - start) * FPS) / 1000));
      if (due > frame) {
        for (; frame < due; frame++) {
          for (const p of pieces) {
            p.vy += p.coin ? GRAVITY * 0.8 : GRAVITY;
            p.x += p.vx;
            p.y += p.vy;
          }
        }
        draw(ctx, pieces, frame);
      }
      if (frame >= FRAMES) return done.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shown, box]);
  if (!shown || !box) return null;
  const left = Math.round(box.left + box.width / 2 - (W * PX) / 2);
  const top = Math.round(box.top + box.height / 2 - FROM_Y * PX);
  return createPortal(
    <canvas
      ref={canvas}
      width={W}
      height={H}
      aria-hidden="true"
      data-pixel-burst
      style={{ position: 'fixed', left, top, width: W * PX, height: H * PX, imageRendering: 'pixelated', pointerEvents: 'none', zIndex: 2000 }}
    />,
    document.body,
  );
}
