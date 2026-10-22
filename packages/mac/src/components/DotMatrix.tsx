import { useEffect, useRef } from 'react';
import { joinLive } from '../lib/live-motion.js';
import s from './dot-matrix.module.css';

/**
 * Claude at work: a tiny 5×5 dot matrix (corners off, so it reads round) whose dots brighten in
 * turning petals and rings, after dotmatrix's "circular 7" loader. Every one on screen moves with
 * the live clock (lib/live-motion.ts), writing its dots' opacity directly (no React renders). With
 * Reduce Motion it holds still, half lit; while you're not looking at Klaud it rests where it is.
 */

const N = 5;
const CORNERS = new Set(['0,0', '0,4', '4,0', '4,4']);
const CELLS = Array.from({ length: N * N }, (_, i) => ({ row: Math.floor(i / N), col: i % N })).filter((c) => !CORNERS.has(`${c.row},${c.col}`));
const CYCLE_MS = 1600 / 1.8;
const BASE = 0.2;
const PEAK = 0.95;

/** How lit a dot is at time `t` (one turn = 2π). */
export function dotOpacity(row: number, col: number, t: number): number {
  const x = col - 2;
  const y = row - 2;
  const ring = Math.hypot(x, y);
  const angle = Math.atan2(y, x);
  const petal = Math.pow(0.5 + 0.5 * Math.cos(5 * angle - t * 1.7), 2.2);
  const ringWave = 0.5 + 0.5 * Math.cos(ring * 3.3 - t * 1.2);
  const chord = 0.5 + 0.5 * Math.cos((x + y) * 1.6 + t * 1.35);
  return BASE + (PEAK - BASE) * (0.68 * petal + 0.22 * ringWave + 0.1 * chord);
}

/** `label` unset: decorative (it sits in a row that already says what's going on). */
export function DotMatrix({ size = 13, label, className }: { size?: number; label?: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const dots = [...el.children] as HTMLElement[];
    return joinLive(el, (now) => {
      const t = now === null ? 0 : ((now % CYCLE_MS) / CYCLE_MS) * Math.PI * 2;
      CELLS.forEach((c, i) => {
        const el = dots[i];
        if (el) el.style.opacity = dotOpacity(c.row, c.col, t).toFixed(3);
      });
    });
  }, []);
  return (
    <span ref={box} className={`${s.matrix}${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} data-dot-matrix {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      {CELLS.map((c) => (
        <i key={`${c.row}${c.col}`} style={{ gridRow: c.row + 1, gridColumn: c.col + 1 }} />
      ))}
    </span>
  );
}
