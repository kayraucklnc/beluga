import { describe, expect, it } from 'vitest';
import { advance, balls, metaPath, OMEGA, startAngles } from '../packages/companion/lib/metaballs.js';

/** The voice's liquid blob (packages/companion/lib/metaballs.ts, BLG-162): one whole shape, always inside its canvas. */
const size = 88;
const numbers = (d: string) => [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));

describe('the voice blob', () => {
  it('is closed loops, inside the canvas, whatever the voice does', () => {
    for (let t = 0; t < 20; t += 0.37) {
      for (const [level, speak, writing, pulse] of [[0, 0, 0, 0], [1, 1, 0, 0], [5, 1, 0, 0.5], [0.4, 1, 0, 0.9], [0, 0, 1, 0]] as const) {
        const p = balls(t, advance(startAngles(), t, writing), level, speak, writing, pulse, 1, size);
        const d = metaPath(p.xs, p.ys, p.rs, size, 1);
        expect(d.length).toBeGreaterThan(20);
        expect(d.split('M').length - 1).toBe(d.split('Z').length - 1);
        for (const n of numbers(d)) {
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(size);
        }
      }
    }
  });

  it('is one drop when quiet, and buds a second piece off at a pause', () => {
    const quiet = balls(1, advance(startAngles(), 1, 0), 0, 0, 0, 0, 1, size);
    expect(metaPath(quiet.xs, quiet.ys, quiet.rs, size, 1).split('M').length - 1).toBe(1);
    // Halfway out the droplet is far from the rest: at some moment it's its own loop.
    const loops = [0.35, 0.45, 0.5, 0.55, 0.65].map((pulse) => {
      const b = balls(1, advance(startAngles(), 1, 0), 0.2, 0, 0, pulse, 1, size);
      return metaPath(b.xs, b.ys, b.rs, size, 1).split('M').length - 1;
    });
    expect(Math.max(...loops)).toBeGreaterThanOrEqual(2);
  });

  it('moves without a jump: the idle motion loops every 16 s, and a change of speed carries the angle on', () => {
    // Quiet, the shape at t and t + 16 s is the same.
    let angles = startAngles();
    const at0 = balls(0, angles, 0, 0, 0, 0, 1, size);
    for (let i = 0; i < 16 * 60; i++) angles = advance(angles, 1 / 60, 0);
    const at16 = balls(16, angles, 0, 0, 0, 0, 1, size);
    at0.xs.forEach((x, i) => expect(at16.xs[i]).toBeCloseTo(x, 3));
    expect(OMEGA * 16).toBeCloseTo(2 * Math.PI, 9);
    // Writing it down: the angles turn faster from where they are, never leap.
    const before = startAngles();
    const step = advance(before, 1 / 60, 1);
    step.forEach((a, k) => expect(Math.abs(a - before[k]!)).toBeLessThan(0.1));
  });

  it('grows from a drop when it starts', () => {
    const small = balls(0, startAngles(), 0, 0, 0, 0, 0, size);
    const full = balls(0, startAngles(), 0, 0, 0, 0, 1, size);
    expect(small.rs[0]!).toBeLessThan(full.rs[0]! * 0.5);
  });
});
