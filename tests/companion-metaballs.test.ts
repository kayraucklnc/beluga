import { describe, expect, it } from 'vitest';
import { balls, metaPath, sheenPath } from '../packages/companion/lib/metaballs.js';

/** The voice's liquid blob (packages/companion/lib/metaballs.ts, BLG-162): one whole shape, always inside its canvas. */
const size = 88;
const numbers = (d: string) => [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));

describe('the voice blob', () => {
  it('is closed loops, inside the canvas, whatever the voice does', () => {
    for (let t = 0; t < 20; t += 0.37) {
      for (const [level, speak, writing, pulse] of [[0, 0, 0, 0], [1, 1, 0, 0], [5, 1, 0, 0.5], [0.4, 1, 0, 0.9], [0, 0, 1, 0]] as const) {
        const p = balls(t, level, speak, writing, pulse, size);
        const d = metaPath(p.xs, p.ys, p.rs, size, 1, 0, 0);
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
    const quiet = balls(1, 0, 0, 0, 0, size);
    expect(metaPath(quiet.xs, quiet.ys, quiet.rs, size, 1, 0, 0).split('M').length - 1).toBe(1);
    // Halfway out the droplet is far from the rest: at some moment it's its own loop.
    const loops = [0.35, 0.45, 0.5, 0.55, 0.65].map((pulse) => {
      const b = balls(1, 0.2, 0, 0, pulse, size);
      return metaPath(b.xs, b.ys, b.rs, size, 1, 0, 0).split('M').length - 1;
    });
    expect(Math.max(...loops)).toBeGreaterThanOrEqual(2);
  });

  it('draws its sheen as one closed curve on the core', () => {
    const d = sheenPath(44, 44, 15);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    for (const n of numbers(d)) expect(Math.abs(n - 40)).toBeLessThan(20);
  });
});
