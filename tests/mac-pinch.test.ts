import { describe, expect, it } from 'vitest';
import { anchorScroll, clampZoom, pinchStep } from '../packages/mac/src/components/pinch-model.js';

/** Pinching a picture or a PDF: how far a trackpad pinch zooms, its limits, and keeping your place. */
describe('pinch to zoom', () => {
  it('spreading the fingers (Ctrl+wheel up) zooms in, pinching zooms out, a little per event', () => {
    expect(pinchStep(1, -10)).toBeGreaterThan(1);
    expect(pinchStep(1, 10)).toBeLessThan(1);
    expect(pinchStep(2, -10) / 2).toBeCloseTo(pinchStep(1, -10), 5);
    // A big jump (a mouse wheel with Ctrl) is capped.
    expect(pinchStep(1, -1000)).toBeLessThanOrEqual(1.5);
  });

  it('stays between its limits', () => {
    expect(clampZoom(0.01)).toBe(0.1);
    expect(clampZoom(50)).toBe(8);
    expect(clampZoom(2, 0.25, 6)).toBe(2);
  });

  it('keeps the point under the fingers where it was', () => {
    // 100px into a view scrolled to 200: the point is at 300; at twice the size it's at 600.
    expect(anchorScroll(200, 100, 2)).toBe(500);
    expect(anchorScroll(0, 50, 1)).toBe(0);
  });
});
