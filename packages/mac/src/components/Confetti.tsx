import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { reducedMotion } from '../lib/reduced-motion.js';

/**
 * A short burst of confetti over the window, in soft pastels: paper that drifts and settles, no
 * sparkle or glow. One canvas, no library; it clears itself after a few seconds and never takes a
 * click. With less motion asked for (Settings › Appearance or the system) there is none.
 */

const COLORS = ['#f7c5cc', '#fbd9b4', '#fbefb0', '#c8ebd3', '#bfe1f2', '#d4ccf3', '#f3cbe6'];
const PIECES = 150;
const LIFE_MS = 3600;
const GRAVITY = 0.16;
const DRAG = 0.985;

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
  /** Turning over: the piece's width shrinks and grows as it flips. */
  flip: number;
  flipSpeed: number;
  w: number;
  h: number;
  round: boolean;
  color: string;
}

function burst(width: number, height: number): Piece[] {
  const at = { x: width / 2, y: height * 0.2 };
  return Array.from({ length: PIECES }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.95;
    const speed = 5 + Math.random() * 8;
    return {
      x: at.x + (Math.random() - 0.5) * 80,
      y: at.y,
      vx: Math.cos(angle) * speed * 1.25,
      vy: Math.sin(angle) * speed,
      spin: (Math.random() - 0.5) * 0.2,
      angle: Math.random() * Math.PI,
      flip: Math.random() * Math.PI,
      flipSpeed: 0.05 + Math.random() * 0.1,
      w: 6 + Math.random() * 5,
      h: 8 + Math.random() * 6,
      round: Math.random() < 0.22,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    };
  });
}

export function Confetti({ onDone }: { onDone?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const still = reducedMotion();
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (still || !el || !ctx) return onDone?.();
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    el.width = width * dpr;
    el.height = height * dpr;
    ctx.scale(dpr, dpr);
    const pieces = burst(width, height);
    const start = performance.now();
    let frame = 0;
    const draw = (now: number): void => {
      const t = now - start;
      ctx.clearRect(0, 0, width, height);
      // The last second fades everything out, so nothing just vanishes.
      ctx.globalAlpha = Math.min(1, Math.max(0, (LIFE_MS - t) / 1000));
      for (const p of pieces) {
        p.vx *= DRAG;
        p.vy = p.vy * DRAG + GRAVITY;
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;
        p.flip += p.flipSpeed;
        if (p.y > height + 20) continue;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.scale(Math.cos(p.flip), 1);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (t < LIFE_MS) frame = requestAnimationFrame(draw);
      else onDone?.();
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
    // Once per mount: a new burst is a new Confetti.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (still) return null;
  return createPortal(<canvas ref={canvas} aria-hidden="true" data-confetti style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', zIndex: 60, pointerEvents: 'none' }} />, document.body);
}
