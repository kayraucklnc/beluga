import { BELUGA } from '../components/beluga-path.js';

/**
 * The menu-bar whale spouting water from its blowhole, as one frame at a time (BLG-280).
 *
 * Drawn in the tray icon's own box (scripts/make-icons.mjs: 912 × 730 of the beluga's 1024 box,
 * 18 points tall), black on clear: macOS tints it for light and dark bars. The whale tips forward,
 * nose down, so its blowhole comes level and there's sky above it; a jet shoots up, opens into two
 * curls, breaks into drops that fall away, and the whale rolls back to rest. Frame 0 and the last
 * are the resting icon, so playing it never jumps.
 */

/** How the spout plays: `splash` 0 (a small puff) to 1 (a big splash), `speed` 0 (slow) to 1 (quick). */
export interface SpoutLook {
  readonly splash: number;
  readonly speed: number;
}

export const BOX = { x: 56, y: 147, w: 912, h: 730 } as const;
/** The icon in pixels: 18 points tall at @2x. */
export const ICON_H = 36;
export const ICON_W = 45;
export const FPS = 30;

/** Where the blowhole is on the drawing (the 1024 box), just behind the melon. */
const BLOWHOLE = { x: 700, y: 190 };
/** The whale turns and dips about its middle. */
const PIVOT = { x: 520, y: 560 };

const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));
const span = (t: number, a: number, b: number): number => clamp((t - a) / (b - a));
const smooth = (p: number): number => p * p * (3 - 2 * p);
const outCubic = (p: number): number => 1 - (1 - p) ** 3;
const inCubic = (p: number): number => p ** 3;
/** 0 → 1 → 0 over [a, b], smoothly. */
const bump = (t: number, a: number, b: number): number => (t <= a || t >= b ? 0 : Math.sin(Math.PI * span(t, a, b)));
const n = (v: number): string => v.toFixed(1);

/** How long one spout takes. */
export function spoutMs(look: SpoutLook): number {
  return Math.round(2000 - 900 * clamp(look.speed));
}

export function frameCount(look: SpoutLook): number {
  return Math.max(2, Math.round((spoutMs(look) / 1000) * FPS));
}

/** How far the whale has tipped (degrees, nose down) and dipped, at `t`; `tip` 0 at rest to 1 tipped all the way. */
function pose(t: number, splash: number): { angle: number; scale: number; dy: number; tip: number } {
  // Tip forward, hold while it blows, roll back and bob once as it settles.
  const into = smooth(span(t, 0.02, 0.24));
  const back = span(t, 0.66, 1);
  const tip = into * (1 - smooth(back));
  const bob = 6 * bump(t, 0.66, 1);
  const recoil = bump(t, 0.2, 0.32);
  return {
    angle: (16 + 8 * splash) * tip,
    scale: 1 - (0.07 + 0.07 * splash) * tip - 0.035 * recoil,
    dy: (26 + 20 * splash) * tip + 14 * recoil + bob,
    tip,
  };
}

/** The drawing's points (its curves' ends and handles: the curves never leave them), for measuring it tipped. */
const POINTS = (() => {
  const nums = (BELUGA.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
  return pts;
})();

/** Inside the icon's box, this far from each edge. */
const MARGIN = 24;

/**
 * Tipped all the way, the nose and the water reach past the icon's edges: how much to shrink the
 * whole scene (about the pivot) and move it so it all fits. Each frame uses as much of this as the
 * whale has tipped, so the resting icon is untouched.
 */
function fitFor(splash: number): { s: number; dx: number; dy: number } {
  const g = 0.7 + 0.5 * splash;
  const { angle, scale, dy } = pose(0.45, splash);
  const whale = POINTS.map((p) => place(p, angle, scale, dy));
  const hole = place(BLOWHOLE, angle, scale, dy);
  const reachX = 160 * g + 20;
  const xs = [...whale.map((p) => p.x), hole.x - reachX, hole.x + reachX];
  const ys = [...whale.map((p) => p.y), BOX.y + MARGIN];
  const b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  const inner = { x0: BOX.x + MARGIN, x1: BOX.x + BOX.w - MARGIN, y0: BOX.y + MARGIN, y1: BOX.y + BOX.h - MARGIN };
  const s = Math.min(1, (inner.x1 - inner.x0) / (b.x1 - b.x0), (inner.y1 - inner.y0) / (b.y1 - b.y0));
  const at = (v: number, c: number): number => c + (v - c) * s;
  const shift = (lo: number, hi: number, min: number, max: number): number => (lo < min ? min - lo : hi > max ? max - hi : 0);
  return {
    s,
    dx: shift(at(b.x0, PIVOT.x), at(b.x1, PIVOT.x), inner.x0, inner.x1),
    dy: shift(at(b.y0, PIVOT.y), at(b.y1, PIVOT.y), inner.y0, inner.y1),
  };
}

function place(p: { x: number; y: number }, angle: number, scale: number, dy: number): { x: number; y: number } {
  const r = (angle * Math.PI) / 180;
  const x = (p.x - PIVOT.x) * scale;
  const y = (p.y - PIVOT.y) * scale;
  return { x: PIVOT.x + x * Math.cos(r) - y * Math.sin(r), y: PIVOT.y + x * Math.sin(r) + y * Math.cos(r) + dy };
}

/** A quadratic curve's points from `p0` to `p1` of the way along. */
function quad(a: { x: number; y: number }, c: { x: number; y: number }, b: { x: number; y: number }, p0: number, p1: number): string {
  const pts: string[] = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const u = p0 + ((p1 - p0) * i) / steps;
    const x = (1 - u) ** 2 * a.x + 2 * (1 - u) * u * c.x + u ** 2 * b.x;
    const y = (1 - u) ** 2 * a.y + 2 * (1 - u) * u * c.y + u ** 2 * b.y;
    pts.push(`${i ? 'L' : 'M'}${n(x)} ${n(y)}`);
  }
  return pts.join(' ');
}

/** The drops: each curl's end breaks into a few that keep going out and down (a fixed spread, the same every time). */
function drops(count: number): Array<{ side: number; vx: number; vy: number; r: number; delay: number }> {
  return Array.from({ length: count }, (_, i) => {
    const side = i % 2 ? 1 : -1;
    const k = Math.floor(i / 2);
    const jitter = Math.sin(i * 12.9898) * 0.5;
    return { side, vx: side * (60 + 70 * k + 25 * jitter), vy: -120 + 60 * k + 40 * jitter, r: 22 - 3 * k + 3 * jitter, delay: 0.035 * k };
  });
}

/** One frame of the spout, `t` from 0 (at rest) to 1 (at rest again), as an SVG (`ink`: its colour; black for the menu bar's template). */
export function spoutSvg(t: number, look: SpoutLook, size: { w: number; h: number } = { w: ICON_W, h: ICON_H }, ink = '#000'): string {
  const splash = clamp(look.splash);
  const { angle, scale, dy, tip } = pose(t, splash);
  const hole = place(BLOWHOLE, angle, scale, dy);
  const g = 0.7 + 0.5 * splash;
  // Room for the curls' arch (and their thickness) under the top edge.
  const top = BOX.y + 40 + 48 * g;
  const reach = Math.max(60, hole.y - top);
  const parts: string[] = [];

  // The jet (straight up, whatever the whale's tilt): shoots up, then its foot lifts off the blowhole and it runs out into the crown.
  const rise = outCubic(span(t, 0.22, 0.42));
  const lift = inCubic(span(t, 0.46, 0.64));
  if (rise > 0 && lift < 1) {
    const tipY = hole.y - reach * rise;
    const footY = hole.y - reach * rise * lift;
    const foot = 18 + 8 * splash;
    const head = 30 + 14 * splash;
    parts.push(
      `<path d="M${n(hole.x - foot)} ${n(footY)} Q${n(hole.x - foot * 0.6)} ${n((footY + tipY) / 2)} ${n(hole.x - head)} ${n(tipY)} L${n(hole.x + head)} ${n(tipY)} Q${n(hole.x + foot * 0.6)} ${n((footY + tipY) / 2)} ${n(hole.x + foot)} ${n(footY)} Z"/>`,
    );
  }

  // The crown: two curls open out from the top and fall, thinning from the root as they go.
  const crown = { x: hole.x, y: hole.y - reach };
  const grow = outCubic(span(t, 0.34, 0.54));
  const fade = smooth(span(t, 0.52, 0.72));
  if (grow > 0 && fade < 1) {
    const width = (26 + 10 * splash) * (1 - 0.55 * fade);
    for (const side of [-1, 1]) {
      const c = { x: crown.x + side * 100 * g, y: crown.y - 80 * g };
      const end = { x: crown.x + side * 160 * g, y: crown.y + 70 * g };
      parts.push(`<path d="${quad(crown, c, end, fade * 0.9, Math.max(fade * 0.9 + 0.02, grow))}" fill="none" stroke="${ink}" stroke-width="${n(width)}" stroke-linecap="round"/>`);
    }
    // A short plume straight up in the middle.
    const plume = (40 + 30 * splash) * grow * (1 - fade);
    if (plume > 4) parts.push(`<path d="M${n(crown.x)} ${n(crown.y)} L${n(crown.x)} ${n(crown.y - plume)}" stroke="${ink}" stroke-width="${n(width * 0.8)}" stroke-linecap="round"/>`);
  }

  // The drops: fly on from the curls' ends and fall away beside the head, shrinking and fading.
  const count = 4 + 2 * Math.round(2 * splash);
  for (const d of drops(count)) {
    const p = span(t, 0.5 + d.delay, 0.97);
    if (p <= 0 || p >= 1) continue;
    const r = d.r * (1 - 0.45 * p) * (0.85 + 0.25 * splash);
    // The head is near the right edge: drops on that side fall steeper, and none leave the box.
    const x = clamp(crown.x + d.side * (d.side > 0 ? 115 : 150) * g + d.vx * (d.side > 0 ? 0.3 : 1) * g * p, BOX.x + MARGIN + r, BOX.x + BOX.w - MARGIN - r);
    const y = crown.y + 60 * g + d.vy * g * p + (reach * 0.55 + 200 * g) * p * p;
    parts.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" opacity="${n(1 - smooth(span(p, 0.6, 1)))}"/>`);
  }

  const fit = fitFor(splash);
  const fs = 1 - (1 - fit.s) * tip;
  const scene = tip > 0 ? ` transform="translate(${n(fit.dx * tip + PIVOT.x)} ${n(fit.dy * tip + PIVOT.y)}) scale(${fs.toFixed(4)}) translate(${-PIVOT.x} ${-PIVOT.y})"` : '';
  const whale = angle === 0 && scale === 1 && dy === 0 ? '' : ` transform="translate(${n(PIVOT.x)} ${n(PIVOT.y + dy)}) rotate(${angle.toFixed(2)}) scale(${scale.toFixed(4)}) translate(${-PIVOT.x} ${-PIVOT.y})"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.w}" height="${size.h}" viewBox="${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}"><g fill="${ink}"${scene}><path fill-rule="evenodd"${whale} d="${BELUGA}"/>${parts.join('')}</g></svg>`;
}

/** Every frame of one spout, first and last at rest. */
export function spoutFrames(look: SpoutLook, size?: { w: number; h: number }): string[] {
  const count = frameCount(look);
  return Array.from({ length: count }, (_, i) => spoutSvg(i / (count - 1), look, size));
}
