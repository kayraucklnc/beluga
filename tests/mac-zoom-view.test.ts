import { describe, expect, it } from 'vitest';
import { VIEW_MAX, clampView, doubleClickScale, fitScale, fitView, isZoomed, panBy, transformOf, zoomAt } from '../packages/mac/src/components/zoom-model.js';
import { settleScroll } from '../packages/mac/src/components/pinch-model.js';

/** The full-size image viewer (BLG-112): fitted and centered at any size and shape, zoomed around the cursor, moved by a transform. */
describe('zoom view', () => {
  const frame = { w: 1200, h: 800 };

  it('fits the whole picture in the frame, never past its own size', () => {
    expect(fitScale({ w: 2400, h: 1600 }, frame)).toBe(0.5);
    expect(fitScale({ w: 600, h: 3200 }, frame)).toBe(0.25);
    expect(fitScale({ w: 4800, h: 400 }, frame)).toBe(0.25);
    expect(fitScale({ w: 300, h: 200 }, frame)).toBe(1);
    expect(fitScale({ w: 2400, h: 1600 }, frame, 100)).toBe(600 / 1600);
    expect(fitScale({ w: 0, h: 0 }, frame)).toBe(1);
  });

  // Where the picture is drawn on screen, the frame's center being (0, 0).
  const drawn = (v: { scale: number; x: number; y: number }, img: { w: number; h: number }) => {
    const m = /translate3d\((-?\d+)px, (-?\d+)px, 0\) scale\(([\d.]+)\)/.exec(transformOf(v, img))!;
    const [left, top, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return { left, top, right: left + img.w * s, bottom: top + img.h * s };
  };

  it('opens centered both ways, whatever its size and shape', () => {
    for (const img of [{ w: 2400, h: 1600 }, { w: 600, h: 3200 }, { w: 4800, h: 400 }, { w: 301, h: 199 }, { w: 1, h: 1 }]) {
      const v = fitView(img, frame, 24);
      const d = drawn(v, img);
      // As much room on the left as on the right, above as below (within the rounding to a pixel).
      expect(Math.abs(d.left + d.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(d.top + d.bottom)).toBeLessThanOrEqual(1);
      expect(d.right - d.left).toBeLessThanOrEqual(frame.w);
      expect(d.bottom - d.top).toBeLessThanOrEqual(frame.h);
    }
  });

  it('zooms around the cursor: the point under it stays under it', () => {
    const img = { w: 2400, h: 1600 };
    const fit = fitScale(img, frame);
    const v = zoomAt(fitView(img, frame), 1, { x: 200, y: -100 }, img, frame, fit);
    expect(v.scale).toBe(1);
    // The point that was under (200, -100) at half size is ((200, -100) - center) / 0.5 into the picture: still under it.
    expect(v.x).toBe(200 - 200 * 2);
    expect(v.y).toBe(-100 + 100 * 2);
    expect(isZoomed(v, fit)).toBe(true);
  });

  it('zooming out stops at the fitted size, centered again; zooming in stops at its limit', () => {
    const img = { w: 2400, h: 1600 };
    const fit = fitScale(img, frame);
    const zoomed = zoomAt(fitView(img, frame), 2, { x: 500, y: 300 }, img, frame, fit);
    const back = zoomAt(zoomed, 0.01, { x: 500, y: 300 }, img, frame, fit);
    expect(back).toEqual({ scale: fit, x: 0, y: 0 });
    expect(zoomAt(zoomed, 100, { x: 0, y: 0 }, img, frame, fit).scale).toBe(VIEW_MAX);
  });

  it('can’t be pulled past its edges, and an axis that fits stays centered', () => {
    const img = { w: 2400, h: 400 };
    const v = { scale: 1, x: 0, y: 0 };
    // 2400 wide in a 1200 frame: 600 px to either side at most. 400 tall: fits, so centered.
    expect(panBy(v, 5000, 300, img, frame)).toEqual({ scale: 1, x: 600, y: 0 });
    expect(panBy(v, -5000, -300, img, frame)).toEqual({ scale: 1, x: -600, y: 0 });
    expect(clampView({ scale: 1, x: 10, y: 10 }, { w: 100, h: 100 }, frame)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('a double-click goes to actual size (twice the size if it already fits at its own), and back', () => {
    expect(doubleClickScale({ scale: 0.5, x: 0, y: 0 }, 0.5)).toBe(1);
    expect(doubleClickScale({ scale: 1, x: 0, y: 0 }, 1)).toBe(2);
    expect(doubleClickScale({ scale: 1, x: 40, y: 0 }, 0.5)).toBe(0.5);
  });

  it('after a pinch is laid out, scrolls the point back under the fingers', () => {
    // The point is drawn 120 px right of where the fingers are: scroll 120 further.
    expect(settleScroll(300, 520, 400)).toBe(420);
    expect(settleScroll(10, 0, 400)).toBe(0);
  });
});
