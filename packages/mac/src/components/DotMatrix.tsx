import { useEffect, useRef } from 'react';
import { joinLive } from '../lib/live-motion.js';
import s from './dot-matrix.module.css';

/**
 * Claude at work: a tiny 5×5 dot matrix (corners off, so it reads round) whose dots brighten in
 * a pattern after dotmatrix's loaders. `petals` ("circular 7": turning petals and rings) is a
 * conversation or a sub-agent; `orbit` ("circular 6": three sectors orbiting a lit centre) is the
 * bigger work, a worktree or a plan. Every one on screen moves with the live clock
 * (lib/live-motion.ts), writing its dots' opacity directly (no React renders). With Reduce Motion
 * it holds still; while you're not looking at Beluga it rests where it is.
 */

export type DotPattern = 'petals' | 'orbit';

const N = 5;
const CORNERS = new Set(['0,0', '0,4', '4,0', '4,4']);
const CELLS = Array.from({ length: N * N }, (_, i) => ({ row: Math.floor(i / N), col: i % N })).filter((c) => !CORNERS.has(`${c.row},${c.col}`));
const CYCLE_MS: Record<DotPattern, number> = { petals: 1600 / 1.8, orbit: 1700 / 1.6 };
const BASE = 0.2;
const PEAK = 0.95;

/** How lit a dot is at time `t` (one turn = 2π), in "circular 7". */
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

const ORBIT_DIM = 0.14;
const ORBIT_NEAR = 0.38;

/** How lit a dot is at time `t` in "circular 6": three sectors orbiting, a ring wave, the centre never dark. */
export function orbitOpacity(row: number, col: number, t: number): number {
  const x = col - 2;
  const y = row - 2;
  const angle = Math.atan2(y, x);
  const ring = Math.hypot(x, y);
  const sector = ((angle - t * 0.95 + Math.PI * 4) % (Math.PI * 2)) / ((Math.PI * 2) / 3);
  const pulse = Math.max(0, 1 - Math.abs(sector - Math.floor(sector) - 0.5) * 2);
  const score = 0.74 * pulse + 0.26 * (0.5 + 0.5 * Math.cos(ring * 3.2 + t * 1.7));
  // Stepped, as dotmatrix draws it (a dimmer floor than theirs, so it still reads at 13px).
  const opacity = score > 0.84 ? PEAK : score > 0.63 ? 0.62 : score > 0.44 ? ORBIT_NEAR : ORBIT_DIM;
  return x === 0 && y === 0 ? Math.max(opacity, ORBIT_NEAR) : opacity;
}

const OPACITY: Record<DotPattern, (row: number, col: number, t: number) => number> = { petals: dotOpacity, orbit: orbitOpacity };

/** `label` unset: decorative (it sits in a row that already says what's going on). */
export function DotMatrix({ size = 13, label, className, pattern = 'petals' }: { size?: number; label?: string; className?: string; pattern?: DotPattern }) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const dots = [...el.children] as HTMLElement[];
    const lit = OPACITY[pattern];
    const cycle = CYCLE_MS[pattern];
    return joinLive(el, (now) => {
      const t = now === null ? 0 : ((now % cycle) / cycle) * Math.PI * 2;
      CELLS.forEach((c, i) => {
        const el = dots[i];
        if (el) el.style.opacity = lit(c.row, c.col, t).toFixed(3);
      });
    });
  }, [pattern]);
  return (
    <span ref={box} className={`${s.matrix}${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} data-dot-matrix={pattern} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      {CELLS.map((c) => (
        <i key={`${c.row}${c.col}`} style={{ gridRow: c.row + 1, gridColumn: c.col + 1 }} />
      ))}
    </span>
  );
}
