/**
 * Pinch to zoom, as plain numbers: how much one pinch event zooms, the limits, and where to scroll
 * so the point under your fingers stays put. No DOM here, so it's tested on its own.
 */

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
/** How much one Ctrl+wheel event may zoom at most (a mouse wheel's big steps). */
const STEP_MAX = 1.5;

export const clampZoom = (z: number, min = ZOOM_MIN, max = ZOOM_MAX): number => Math.min(max, Math.max(min, z));

/** The zoom after a trackpad pinch's wheel event (Chromium sends pinches as Ctrl+wheel; up is spread). */
export function pinchStep(zoom: number, deltaY: number): number {
  const factor = Math.min(STEP_MAX, Math.max(1 / STEP_MAX, Math.exp(-deltaY * 0.01)));
  return zoom * factor;
}

/** Where to scroll (one axis) so what was `offset` px into the view at `scroll` stays there after zooming by `ratio`. */
export const anchorScroll = (scroll: number, offset: number, ratio: number): number => Math.max(0, (scroll + offset) * ratio - offset);
