/**
 * The voice blob's shape (components/Metaballs.tsx, BLG-162), kept free of React Native so it can be
 * drawn anywhere (and checked as pictures). Both run as worklets on the UI thread, every frame.
 */

/** Grid cells across the canvas: enough for a smooth outline at this size, cheap enough for every frame. */
const N = 38;

/**
 * The outline where the field Σ r²/d² reaches `thr`, as one SVG path of closed, smoothed loops.
 * `xs`/`ys`/`rs`: the balls; `ox`/`oy`: where to draw it (a highlight sits a little up and left).
 */
export function metaPath(xs: number[], ys: number[], rs: number[], size: number, thr: number, ox: number, oy: number): string {
  'worklet';
  const cell = size / N;
  const W = N + 1;
  const f: number[] = new Array(W * W);
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = i * cell;
      const y = j * cell;
      let v = 0;
      for (let b = 0; b < xs.length; b++) {
        const dx = x - xs[b]!;
        const dy = y - ys[b]!;
        v += (rs[b]! * rs[b]!) / (dx * dx + dy * dy + 0.01);
      }
      // The edge of the canvas is always outside, so every outline closes (never an open, broken shape).
      f[j * W + i] = i === 0 || j === 0 || i === N || j === N ? 0 : v;
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
  // Walk each loop and draw it smooth: through the midpoints, each corner a curve's control.
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
      lx.push(px[cur]! + ox);
      ly.push(py[cur]! + oy);
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

/** Where the five balls are now: a core that breathes, four that drift, push out with the voice, and one that buds off at a pause. */
export function balls(t: number, level: number, speak: number, writing: number, pulse: number, size: number): { xs: number[]; ys: number[]; rs: number[] } {
  'worklet';
  const c = size / 2;
  // Quiet voices still move it: the level is lifted (a soft curve), and capped so it never bursts.
  level = Math.max(0, Math.min(1, Math.pow(Math.max(0, level), 0.8) * 1.35));
  const xs: number[] = [];
  const ys: number[] = [];
  const rs: number[] = [];
  // The core.
  xs.push(c + Math.sin(t * 0.9) * size * 0.02);
  ys.push(c + Math.cos(t * 0.7) * size * 0.02);
  rs.push(size * (0.16 + level * 0.04 + Math.sin(t * 1.6) * 0.006));
  const speeds = [0.55, -0.42, 0.7, -0.63];
  const phases = [0, 1.7, 3.3, 4.9];
  const sizes = [0.1, 0.085, 0.075, 0.09];
  for (let k = 0; k < 4; k++) {
    // Writing it down: they circle close and quick. Listening: they drift, and go further while you speak.
    const spin = writing * (k % 2 === 0 ? 2.4 : -2.4);
    const angle = t * (speeds[k]! + spin) + phases[k]!;
    const breathe = 0.5 + 0.5 * Math.sin(t * (0.8 + k * 0.23) + phases[k]! * 2);
    let dist = size * ((0.07 + 0.05 * breathe) * (1 - writing * 0.45) + (0.04 + 0.07 * breathe) * level * (1 - writing) + 0.05 * speak * (1 - writing));
    let rad = size * sizes[k]! * (1 + level * 0.3 * (1 - writing));
    let ax = Math.cos(angle);
    let ay = Math.sin(angle);
    // A pause: the first ball buds off toward the words (right, a little up) and flows back in.
    if (k === 0 && pulse > 0) {
      const out = Math.sin(pulse * Math.PI);
      const tx = 0.94;
      const ty = -0.34;
      ax = ax + (tx - ax) * Math.min(1, out * 1.6);
      ay = ay + (ty - ay) * Math.min(1, out * 1.6);
      dist += size * 0.27 * out;
      rad *= 1 - 0.45 * out;
    }
    // Never past the edge: the blob stays whole inside its canvas.
    const reach = size / 2 - rad * 1.25 - 2;
    if (dist > reach) dist = reach;
    xs.push(c + ax * dist);
    ys.push(c + ay * dist);
    rs.push(rad);
  }
  return { xs, ys, rs };
}


/** A soft sheen on the core: an ellipse up and to the left of its middle, turned a little. */
export function sheenPath(x: number, y: number, r: number): string {
  'worklet';
  const cx = x - r * 0.32;
  const cy = y - r * 0.38;
  const rx = r * 0.46;
  const ry = r * 0.3;
  const a = -0.5;
  const k = 0.5523;
  const p = (u: number, v: number): string => {
    const px = cx + u * Math.cos(a) - v * Math.sin(a);
    const py = cy + u * Math.sin(a) + v * Math.cos(a);
    return `${Math.round(px * 10) / 10} ${Math.round(py * 10) / 10}`;
  };
  return `M${p(rx, 0)}C${p(rx, ry * k)} ${p(rx * k, ry)} ${p(0, ry)}C${p(-rx * k, ry)} ${p(-rx, ry * k)} ${p(-rx, 0)}C${p(-rx, -ry * k)} ${p(-rx * k, -ry)} ${p(0, -ry)}C${p(rx * k, -ry)} ${p(rx, -ry * k)} ${p(rx, 0)}Z`;
}
