/**
 * A picture in a frame you zoom and pan (the full-size image viewer), as plain numbers: how big it
 * fits, where it sits, and how a zoom keeps the point under the cursor in place. The picture is
 * drawn at its own size and moved with a CSS transform (no layout while you zoom), so all that's
 * kept is a scale and how far its center is from the frame's center. No DOM here, so it's tested
 * on its own.
 */

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** How the picture is shown: its scale, and its center's offset (px) from the frame's center. */
export interface ZoomView {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** Zoomed in this far at most (8× its own size). */
export const VIEW_MAX = 8;

/** The scale that shows all of it inside the frame (less `pad` on each side), never blown up past its own size. */
export function fitScale(img: Size, frame: Size, pad = 0): number {
  if (img.w <= 0 || img.h <= 0) return 1;
  const w = Math.max(1, frame.w - 2 * pad);
  const h = Math.max(1, frame.h - 2 * pad);
  return Math.min(1, w / img.w, h / img.h);
}

/** Fitted and centered, both ways, whatever its size and shape. */
export const fitView = (img: Size, frame: Size, pad = 0): ZoomView => ({ scale: fitScale(img, frame, pad), x: 0, y: 0 });

/** The farthest it may be moved along one axis: centered while it fits, else no gap at either edge. */
const slack = (shown: number, frame: number): number => Math.max(0, (shown - frame) / 2);

/** Kept in the frame: an axis that fits stays centered; one that's bigger can't be pulled past its edges. */
export function clampView(v: ZoomView, img: Size, frame: Size): ZoomView {
  const sx = slack(img.w * v.scale, frame.w);
  const sy = slack(img.h * v.scale, frame.h);
  // `|| 0`: never -0 (it's the same place, but not the same number).
  return { scale: v.scale, x: Math.max(-sx, Math.min(sx, v.x)) || 0, y: Math.max(-sy, Math.min(sy, v.y)) || 0 };
}

/**
 * Zoomed to `scale` around `at` (the cursor, px from the frame's center): the point of the picture
 * under it stays under it, as far as the frame allows (then it's kept centered or at its edge).
 * `min` is usually the fitted scale: zooming out stops there, centered.
 */
export function zoomAt(v: ZoomView, scale: number, at: { readonly x: number; readonly y: number }, img: Size, frame: Size, min: number): ZoomView {
  const to = Math.max(Math.min(min, 1), Math.min(VIEW_MAX, scale));
  const k = to / v.scale;
  return clampView({ scale: to, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }, img, frame);
}

/** Moved by (dx, dy) px (a drag, or two fingers scrolling), kept in the frame. */
export const panBy = (v: ZoomView, dx: number, dy: number, img: Size, frame: Size): ZoomView => clampView({ scale: v.scale, x: v.x + dx, y: v.y + dy }, img, frame);

/** Bigger than fitted (so it pans, and a click on it doesn't close anything). */
export const isZoomed = (v: ZoomView, fit: number): boolean => v.scale > fit + 0.001;

/** A double-click: fitted goes to actual size (or twice the size, when it already fits at its own size); zoomed goes back. */
export const doubleClickScale = (v: ZoomView, fit: number): number => (isZoomed(v, fit) ? fit : fit < 0.999 ? 1 : Math.min(VIEW_MAX, fit * 2));

/**
 * The CSS transform for the picture, laid out at `base` times its own size (the fitted scale, so its
 * box never reaches past the frame) with its top-left at the frame's center (`left: 50%; top: 50%`,
 * `transform-origin: 0 0`). Rounded to whole pixels' worth of offset so it stays sharp at rest. A
 * plain 2D transform: it only gets its own layer while it moves (WKWebView sometimes drew a huge
 * always-on layer far off-center, past the frame's edge).
 */
export function transformOf(v: ZoomView, img: Size, base = 1): string {
  const tx = Math.round(v.x - (img.w * v.scale) / 2);
  const ty = Math.round(v.y - (img.h * v.scale) / 2);
  return `translate(${tx}px, ${ty}px) scale(${v.scale / base})`;
}
