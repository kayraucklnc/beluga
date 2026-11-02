/**
 * The voice blob's shape (components/Metaballs.tsx, BLG-162), kept free of React Native so it can be
 * drawn anywhere (and checked as pictures). Everything here runs as worklets on the UI thread, every
 * frame.
 *
 * Motion that never jumps: every wobble repeats on one 16-second cycle (each a whole number of
 * turns of it), and the satellites' angles are integrated from their speed (`advance`), so when
 * the speed changes (writing it down, they circle faster) the angle carries on from where it was.
 */

/** The cycle every idle motion shares (rad/s for one turn in 16 s): whole multiples of it loop seamlessly. */
export const OMEGA = (2 * Math.PI) / 16;
/** Each satellite's orbit, in turns per cycle (signed), and its breath. */
const ORBIT = [2, -1, 3, -2];
const BREATH = [3, 4, 5, 3];
const PHASE = [0, 1.7, 3.3, 4.9];
const SIZE = [0.1, 0.085, 0.075, 0.09];
/** Writing it down, the satellites circle this much faster (rad/s), alternating ways. */
export const SPIN = 3.2;

/** Grid cells across the canvas: a smooth outline at this size, cheap enough for every frame. */
const N = 48;

/**
 * The satellites' angles, a step on: their own speed, plus the writing-down spin (`spin` scales it; the preview tunes it to loop).
 * SPIN is read in the body, never as a default parameter: the worklets plugin doesn't capture what a
 * default refers to, so on the UI thread it was undefined and the voice screen crashed.
 */
export function advance(angles: readonly number[], dt: number, writing: number, spin?: number): number[] {
  'worklet';
  const s = spin ?? SPIN;
  const out: number[] = [];
  for (let k = 0; k < 4; k++) out.push(angles[k]! + dt * (ORBIT[k]! * OMEGA + writing * s * (k % 2 === 0 ? 1 : -1)));
  return out;
}

export const startAngles = (): number[] => {
  'worklet';
  return [PHASE[0]!, PHASE[1]!, PHASE[2]!, PHASE[3]!];
};

/**
 * Where the five balls are: a core that breathes, four satellites that drift (and go further while
 * you speak), one budding off toward the words at a pause. `born` (0–1) grows it from a drop.
 */
export function balls(t: number, angles: readonly number[], level: number, speak: number, writing: number, pulse: number, born: number, size: number): { xs: number[]; ys: number[]; rs: number[] } {
  'worklet';
  const c = size / 2;
  // Quiet voices still move it: the level is lifted (a soft curve), and capped so it never bursts.
  level = Math.max(0, Math.min(1, Math.pow(Math.max(0, level), 0.8) * 1.35));
  const grow = 0.35 + 0.65 * born;
  const xs: number[] = [];
  const ys: number[] = [];
  const rs: number[] = [];
  // The core, wandering a little on the cycle.
  const cx = c + Math.sin(2 * OMEGA * t) * size * 0.022 + Math.sin(5 * OMEGA * t + 1) * size * 0.008;
  const cy = c + Math.cos(3 * OMEGA * t) * size * 0.02;
  xs.push(cx);
  ys.push(cy);
  rs.push(size * grow * (0.16 + level * 0.04 + Math.sin(4 * OMEGA * t) * 0.006));
  for (let k = 0; k < 4; k++) {
    const breathe = 0.5 + 0.5 * Math.sin(BREATH[k]! * OMEGA * t + PHASE[k]! * 2);
    let dist = size * grow * ((0.07 + 0.05 * breathe) * (1 - writing * 0.45) + (0.04 + 0.07 * breathe) * level * (1 - writing) + 0.05 * speak * (1 - writing));
    let rad = size * grow * SIZE[k]! * (1 + level * 0.3 * (1 - writing));
    let ax = Math.cos(angles[k]!);
    let ay = Math.sin(angles[k]!);
    // A pause: the first one buds off toward the words (right, a little up), pinches off and flows back in.
    if (k === 0 && pulse > 0) {
      const out = Math.sin(pulse * Math.PI);
      const pull = Math.min(1, out * 1.6);
      ax += (0.94 - ax) * pull;
      ay += (-0.34 - ay) * pull;
      const len = Math.hypot(ax, ay) || 1;
      ax /= len;
      ay /= len;
      dist += size * 0.27 * out;
      rad *= 1 - 0.45 * out;
    }
    // Never past the edge: the blob stays whole inside its canvas.
    const reach = size / 2 - rad * 1.25 - 2;
    if (dist > reach) dist = reach;
    xs.push(cx + ax * dist);
    ys.push(cy + ay * dist);
    rs.push(rad);
  }
  return { xs, ys, rs };
}

/**
 * The outline where the field Σ r²/d² reaches `thr`, as one SVG path of closed, smoothed loops:
 * the field on a grid, its outline traced (marching squares, edges shared so loops close), then
 * drawn through the midpoints with each corner a curve's control.
 */
export function metaPath(xs: readonly number[], ys: readonly number[], rs: readonly number[], size: number, thr: number): string {
  'worklet';
  const cell = size / N;
  const W = N + 1;
  const f: number[] = new Array(W * W);
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      // The edge of the canvas is always outside, so every outline closes (never an open, broken shape).
      if (i === 0 || j === 0 || i === N || j === N) {
        f[j * W + i] = 0;
        continue;
      }
      const x = i * cell;
      const y = j * cell;
      let v = 0;
      for (let b = 0; b < xs.length; b++) {
        const dx = x - xs[b]!;
        const dy = y - ys[b]!;
        v += (rs[b]! * rs[b]!) / (dx * dx + dy * dy + 0.01);
      }
      f[j * W + i] = v;
    }
  }
  // Edges: horizontal (i,j)→(i+1,j) are keys j*N+i; vertical (i,j)→(i,j+1) are H + j*W + i.
  const H = W * N;
  const total = H + W * N;
  const px: number[] = new Array(total);
  const py: number[] = new Array(total);
  const a: number[] = new Array(total).fill(-1);
  const b2: number[] = new Array(total).fill(-1);
  const point = (key: number, x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): void => {
    if (px[key] !== undefined) return;
    const t = v1 === v0 ? 0.5 : Math.min(1, Math.max(0, (thr - v0) / (v1 - v0)));
    px[key] = x0 + (x1 - x0) * t;
    py[key] = y0 + (y1 - y0) * t;
  };
  const link = (k1: number, k2: number): void => {
    if (a[k1] === -1) a[k1] = k2;
    else b2[k1] = k2;
    if (a[k2] === -1) a[k2] = k1;
    else b2[k2] = k1;
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const tl = f[j * W + i]!;
      const tr = f[j * W + i + 1]!;
      const br = f[(j + 1) * W + i + 1]!;
      const bl = f[(j + 1) * W + i]!;
      const c = (tl >= thr ? 8 : 0) | (tr >= thr ? 4 : 0) | (br >= thr ? 2 : 0) | (bl >= thr ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const x = i * cell;
      const y = j * cell;
      const T = j * N + i;
      const B = (j + 1) * N + i;
      const L = H + j * W + i;
      const R = H + j * W + i + 1;
      point(T, x, y, tl, x + cell, y, tr);
      point(B, x, y + cell, bl, x + cell, y + cell, br);
      point(L, x, y, tl, x, y + cell, bl);
      point(R, x + cell, y, tr, x + cell, y + cell, br);
      const mid = (tl + tr + br + bl) / 4 >= thr;
      if (c === 1 || c === 14) link(L, B);
      else if (c === 2 || c === 13) link(B, R);
      else if (c === 3 || c === 12) link(L, R);
      else if (c === 4 || c === 11) link(T, R);
      else if (c === 6 || c === 9) link(T, B);
      else if (c === 7 || c === 8) link(L, T);
      else if (c === 5) {
        if (mid) (link(L, T), link(B, R));
        else (link(T, R), link(L, B));
      } else if (c === 10) {
        if (mid) (link(T, R), link(L, B));
        else (link(L, T), link(B, R));
      }
    }
  }
  const seen: boolean[] = new Array(total).fill(false);
  const r = (n: number): number => Math.round(n * 10) / 10;
  let d = '';
  for (let k = 0; k < total; k++) {
    if (a[k] === -1 || seen[k]) continue;
    const lx: number[] = [];
    const ly: number[] = [];
    let prev = -1;
    let cur = k;
    while (cur !== -1 && !seen[cur]) {
      seen[cur] = true;
      lx.push(px[cur]!);
      ly.push(py[cur]!);
      const next = a[cur] !== prev ? a[cur]! : b2[cur]!;
      prev = cur;
      cur = next;
    }
    const m = lx.length;
    if (m < 3) continue;
    d += `M${r((lx[m - 1]! + lx[0]!) / 2)} ${r((ly[m - 1]! + ly[0]!) / 2)}`;
    for (let i = 0; i < m; i++) {
      const n = (i + 1) % m;
      d += `Q${r(lx[i]!)} ${r(ly[i]!)} ${r((lx[i]! + lx[n]!) / 2)} ${r((ly[i]! + ly[n]!) / 2)}`;
    }
    d += 'Z';
  }
  return d;
}

/** How much of the second colour shows (0–1): a slow drift of the hue on the cycle. */
export function hueDrift(t: number): number {
  'worklet';
  return 0.5 - 0.5 * Math.cos(OMEGA * t);
}
