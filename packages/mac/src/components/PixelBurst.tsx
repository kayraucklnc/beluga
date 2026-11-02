import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from '../lib/reduced-motion.js';
import { FPS, FRAMES, FROM_Y, H, PX, type Piece, W, burst, pixels, step } from './pixel-burst-model.js';

/**
 * A new payment: a small burst of pixel-art confetti from an amount (the sidebar's), drawn on a
 * tiny canvas scaled up with crisp pixels and moved a frame at a time, like a sprite. Soft
 * pastel squares, a few gold coins that hop higher, pieces that blink out rather than fade. No
 * glow. Over the window (never clipped by the sidebar), sized so no piece reaches its edge
 * (pixel-burst-model.ts); it never takes a click and clears itself in about a second and a half.
 * With less motion asked for there is none.
 */

function draw(ctx: CanvasRenderingContext2D, pieces: readonly Piece[], frame: number): void {
  ctx.clearRect(0, 0, W, H);
  for (const p of pieces) {
    for (const px of pixels(p, frame)) {
      ctx.fillStyle = px.color;
      ctx.fillRect(px.x, px.y, 1, 1);
    }
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
    const pieces = burst(box.width);
    const start = performance.now();
    let frame = 0;
    let raf = 0;
    draw(ctx, pieces, frame);
    // Stepped: the pieces move only on the sprite's own frames, FPS a second.
    const tick = (now: number): void => {
      const due = Math.min(FRAMES, Math.floor(((now - start) * FPS) / 1000));
      if (due > frame) {
        for (; frame < due; frame++) step(pieces);
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
