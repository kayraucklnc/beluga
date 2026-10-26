/**
 * Max effort's message box: it burns, and every character you type throws a pinch of confetti from
 * the caret.
 *
 * The fire is metaballs on the GPU: blobs of heat rise off the box's edges, and where their fields
 * add up they melt into one flame, then pinch off into wisps as they cool and shrink. Noise bends
 * them sideways the higher they climb, so the flames lick. The field is cut into three flat colours,
 * outer to core (Hades' blue; it flares orange, like his temper, while you type fast), drawn one of
 * two ways (Settings › Writing):
 *   - flame: soft edges, the colours melting into each other, tips that thin out as they climb;
 *   - pixel: big square pixels, moving in steps like an old game.
 * Two canvases: the fire under the box (it hides the roots), the confetti over it.
 */

import { type FlameStyle, TEMPER } from './fire-look.js';

export type { FlameStyle };

/** What the fire engine needs of the look (fire-look.ts): 0–1 dials, three colours. */
export interface FireTune {
  readonly style: FlameStyle;
  readonly show: 'always' | 'typing' | 'off';
  readonly fuel: number;
  readonly height: number;
  readonly thickness: number;
  readonly wildness: number;
  readonly colors: readonly [string, string, string];
  readonly temper: boolean;
  /** Only while typing: how long (s) a run of typing takes to catch, and how long (s) after the last key the fuel runs out. */
  readonly catchAfter: number;
  readonly outAfter: number;
}

export interface FireBox {
  /** The box's place in the canvas (CSS pixels). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Its corner radius (the fire never draws inside the box: its text stays clean). */
  readonly r?: number;
  /** What of the canvas can be seen (its containers clip the rest): the fire tapers to tips before it, never cut. */
  readonly clip?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
}

const CONFETTI = ['#ffe35a', '#ff8a1f', '#3fa2ff', '#d4f6ff', '#ff6fae', '#8fe3b0'] as const;

/**
 * Only while typing: a pause this long (s) ends a run of typing. A run catches once it's `catchAfter`
 * long (Settings) and has had a few keys: up to this many, fewer the sooner it catches, one at once.
 */
const RUN_GAP = 0.7;
const WARM_KEYS = 4;
/** How it spreads round the box from the caret: it takes this long (s) plus a bit per px to go, eased in and out. */
const SPREAD_TIME = 0.7;
const SPREAD_PER_PX = 1 / 700;
/** How wide the spreading front is (CSS px): the flames grow from nothing across it. */
const SPREAD_FRONT = 90;

/** Smooth in and out (0–1). */
const ease = (t: number): number => t * t * (3 - 2 * t);
/** Slow start, fast middle, gentle landing (0–1). */
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Blobs of heat the shader adds up (the most it takes). */
const MAX_BLOBS = 96;
/**
 * Pixel art: one pixel of the fire is this many CSS pixels. The fire is drawn at that size (one
 * shader run per pixel of it, a sixteenth of the screen's) and scaled up crisp by the canvas, so
 * it runs every frame, smoothly, for less than the smooth style costs.
 */
const CELL = 4;

interface Blob {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  decay: number;
}

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  turn: number;
  life: number;
  color: string;
  /** 0 a strip, 1 a dot, 2 a star; 3 a square pixel (what deleting pops into). */
  shape: 0 | 1 | 2 | 3;
  /** A pixel's size (CSS px). */
  size: number;
}

const VERTEX = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
uniform vec2 u_size;
uniform float u_dpr;
uniform vec4 u_box;
uniform float u_time;
uniform float u_cell;
uniform float u_heat;
uniform float u_wild;
uniform float u_tall;
uniform float u_reach;
uniform float u_rimk;
uniform float u_alpha;
uniform float u_round;
uniform vec4 u_clip;
uniform vec3 u_spread;
#define SPREAD_FRONT ${SPREAD_FRONT.toFixed(1)}
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec4 u_blobs[${MAX_BLOBS}];
uniform int u_count;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  // CSS pixels, y down (as the page).
  vec2 p = vec2(gl_FragCoord.x, u_size.y * u_dpr - gl_FragCoord.y) / u_dpr;
  vec2 raw = p;
  if (u_cell > 0.0) p = (floor(p / u_cell) + 0.5) * u_cell;
  vec2 lo = u_box.xy;
  vec2 hi = u_box.xy + u_box.zw;
  // Flames lick: the higher above the box, the more the noise bends them sideways.
  float above = clamp(lo.y - p.y, 0.0, u_reach);
  float bend = noise(vec2(p.x * 0.045, p.y * 0.06 + u_time * 2.2)) - 0.5;
  vec2 q = p + vec2(bend * min(above, 60.0) * (0.2 + u_wild * 1.1), (noise(vec2(p.x * 0.08 - u_time, u_time * 1.7)) - 0.5) * 6.0);

  // The blobs (metaballs): each adds r^2 / d^2, so neighbours melt together.
  float f = 0.0;
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    if (i >= u_count) break;
    vec4 b = u_blobs[i];
    // A teardrop, point up: taller than wide, and narrower the higher above its middle.
    vec2 d = q - b.xy;
    d.y *= 0.45;
    d.x *= 1.0 + max(0.0, -d.y) / max(b.z, 1.0) * 2.4;
    f += b.z * b.z / (dot(d, d) + 1.0);
  }
  // The box's edge burns too: a rim that breathes along its length (less underneath: fire rises).
  vec2 outside = max(max(lo - q, q - hi), 0.0);
  float dist = length(outside);
  float rim = (0.85 + 0.75 * noise(vec2(q.x * 0.06 + u_time * 0.8, q.y * 0.05 - u_time * 1.5))) * (0.8 + u_heat * 0.4) * u_rimk;
  if (q.y > hi.y) rim *= 0.4;
  f += rim * 16.0 / (dist * dist + 16.0);
  // Only while typing it catches at the caret and spreads out from there: past its front nothing
  // burns yet, and towards the front the flames are still small (they grow as it passes).
  float front = 1.0 - smoothstep(u_spread.z - SPREAD_FRONT, u_spread.z, length(q - u_spread.xy));
  f *= front * front * (3.0 - 2.0 * front);

  bool pixel = u_cell > 0.0;
  // Smooth edges with the colours melting into each other (Flame), or hard ones and three flat
  // colours (Pixel Art).
  float soft = pixel ? 0.0001 : 0.22;
  // The outer shell comes to points: it needs more heat the higher it reaches (so every flame
  // closes to a tip), and crested streaks racing up it pull it into licks (Flame: broader, calmer
  // tongues, not thin spikes).
  float rise = clamp(above / 12.0, 0.0, 1.0);
  float ridge = pixel
    ? 1.0 - abs(noise(vec2(q.x * 0.24, q.y * 0.07 + u_time * 5.0)) * 2.0 - 1.0)
    : 1.0 - abs(noise(vec2(q.x * 0.13, q.y * 0.05 + u_time * 3.2)) * 2.0 - 1.0);
  ridge = pixel ? ridge : mix(0.55, ridge, 0.6);
  // Near the edge of what can be seen, the flames need far more heat to show: they narrow into
  // tips before it, instead of being sliced off by it.
  float edge = min(min(raw.x - u_clip.x, u_clip.z - raw.x), min(raw.y - u_clip.y, u_clip.w - raw.y));
  float taper = 1.0 - smoothstep(0.0, 34.0, edge);
  float shell = f + (ridge - 0.55) * (0.45 + u_wild * 0.9) * rise - above * (0.02 - u_tall * 0.015) - taper * taper * 3.5;
  float a = smoothstep(1.0 - soft, 1.0 + soft, shell);
  float blend = pixel ? soft : 0.7;
  vec3 c = mix(u_c0, u_c1, smoothstep(1.9 - blend, 1.9 + blend, f));
  c = mix(c, u_c2, smoothstep(3.6 - blend * 1.4, 3.6 + blend * 1.4, f));
  // Real flames thin out as they climb: the tips go see-through (Flame).
  if (!pixel) a *= 1.0 - 0.45 * smoothstep(8.0, 70.0, above);
  a *= u_alpha;
  // Never inside the box (a rounded rectangle): the fire is around it, its text stays clean
  // (whatever order the browser stacks the canvas and the box in).
  vec2 mid = (lo + hi) * 0.5;
  vec2 corner = abs(raw - mid) - (hi - lo) * 0.5 + u_round;
  float inside = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - u_round;
  a *= smoothstep(-0.5, 0.75, inside) * smoothstep(0.0, 2.0, edge);
  gl_FragColor = vec4(c * a, a);
}
`;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

/** The fire's GPU half: a full-canvas quad and the metaball shader. */
class FlameGL {
  private readonly at: Record<string, WebGLUniformLocation | null> = {};
  private readonly packed = new Float32Array(MAX_BLOBS * 4);

  static make(canvas: HTMLCanvasElement): FlameGL | undefined {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return undefined;
    const shader = (kind: number, src: string): WebGLShader | undefined => {
      const s = gl.createShader(kind)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : undefined;
    };
    const vs = shader(gl.VERTEX_SHADER, VERTEX);
    const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return undefined;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined;
    return new FlameGL(gl, program);
  }

  private constructor(
    private readonly gl: WebGLRenderingContext,
    program: WebGLProgram,
  ) {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['u_size', 'u_dpr', 'u_box', 'u_time', 'u_cell', 'u_heat', 'u_wild', 'u_tall', 'u_reach', 'u_rimk', 'u_alpha', 'u_round', 'u_clip', 'u_spread', 'u_c0', 'u_c1', 'u_c2', 'u_blobs', 'u_count']) this.at[name] = gl.getUniformLocation(program, name);
  }

  draw(o: { width: number; height: number; dpr: number; box: FireBox; time: number; cell: number; heat: number; wild: number; tall: number; reach: number; rim: number; spread: { x: number; y: number; r: number }; alpha: number; colors: readonly Rgb[]; blobs: readonly Blob[] }): void {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.at.u_size!, o.width, o.height);
    gl.uniform1f(this.at.u_dpr!, o.dpr);
    gl.uniform4f(this.at.u_box!, o.box.x, o.box.y, o.box.w, o.box.h);
    gl.uniform1f(this.at.u_time!, o.time);
    gl.uniform1f(this.at.u_cell!, o.cell);
    gl.uniform1f(this.at.u_heat!, o.heat);
    gl.uniform1f(this.at.u_wild!, o.wild);
    gl.uniform1f(this.at.u_tall!, o.tall);
    gl.uniform1f(this.at.u_reach!, o.reach);
    gl.uniform1f(this.at.u_rimk!, o.rim);
    gl.uniform1f(this.at.u_alpha!, o.alpha);
    gl.uniform1f(this.at.u_round!, o.box.r ?? 12);
    const clip = o.box.clip ?? { x0: 0, y0: 0, x1: o.width, y1: o.height };
    gl.uniform4f(this.at.u_clip!, clip.x0, clip.y0, clip.x1, clip.y1);
    gl.uniform3f(this.at.u_spread!, o.spread.x, o.spread.y, o.spread.r);
    o.colors.forEach((c, i) => gl.uniform3f(this.at[`u_c${i}`]!, ...c));
    const n = Math.min(MAX_BLOBS, o.blobs.length);
    for (let i = 0; i < n; i++) {
      const b = o.blobs[i]!;
      // Each swells in as it's born, then shrinks away as it cools.
      this.packed.set([b.x, b.y, b.r * ease(Math.min(1, (1 - b.life) * 4)) * ease(Math.min(1, b.life * 2.5)), 0], i * 4);
    }
    gl.uniform4fv(this.at.u_blobs!, this.packed);
    gl.uniform1i(this.at.u_count!, n);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

export class MaxFire {
  private readonly flame: FlameGL | undefined;
  private readonly front: CanvasRenderingContext2D;
  private tune: FireTune = { style: 'toon', show: 'always', fuel: 0.5, height: 0.5, thickness: 0.5, wildness: 0.5, colors: TEMPER, temper: true, catchAfter: 0.6, outAfter: 0.4 };
  /**
   * What's drawn now, gliding toward `tune` (about half a second), so a new preset or slider
   * changes the fire smoothly instead of all at once; a new style fades in.
   */
  private cur = { fuel: 0.5, height: 0.5, thickness: 0.5, wildness: 0.5, colors: TEMPER.map(rgb) as Rgb[], alpha: 1 };
  private fresh = true;
  /** How much is burning (0–1): all the time, or (only while typing) since the last key. */
  private amount = 1;
  private typedAt = -Infinity;
  /**
   * Only while typing, it takes a run of keys to catch (unless it catches at once): when this run
   * of typing began, and how many keys it has had.
   */
  private runAt = -Infinity;
  private runKeys = 0;
  private lit = false;
  /** Where it caught (the caret then), and how far round the box it has spread from there (CSS px). */
  private origin = { x: 0, y: 0 };
  private spread = Infinity;
  /** How far the spread has got (0–1), and how far it has to go (to the farthest corner of the box). */
  private spreadT = 1;
  private spreadTo = 0;
  private caretAt = { x: 0, y: 0 };
  /** Told how much is burning as it changes (the box's coloured rim fades with it). */
  onBurn: ((amount: number) => void) | undefined;
  private box: FireBox = { x: 0, y: 0, w: 0, h: 0 };
  private width = 0;
  private height = 0;
  private dpr = 1;
  private blobs: Blob[] = [];
  private bits: Bit[] = [];
  private raf = 0;
  private last = 0;
  private time = 0;
  /** The fire canvas's pixels per CSS pixel: the screen's, or one per CELL for pixel art. */
  private fireScale = 1;
  /** How fierce it burns (typing stokes it; it settles back on its own). */
  private heat = 0.4;
  private focused = false;

  /** The fire goes on `behind` (under the box, so it comes out from its edges); confetti on `over`. */
  constructor(
    private readonly behind: HTMLCanvasElement,
    private readonly over: HTMLCanvasElement,
  ) {
    this.flame = FlameGL.make(behind);
    this.front = over.getContext('2d')!;
  }

  setTune(tune: FireTune): void {
    if (!this.fresh && tune.style !== this.tune.style) this.cur.alpha = 0;
    const restyled = tune.style !== this.tune.style;
    this.tune = tune;
    if (restyled) this.sizeFire();
    // The first look is taken as it is; later ones are glided to.
    if (this.fresh) {
      this.fresh = false;
      // Only while typing: nothing burns until the first key.
      this.amount = tune.show === 'always' ? 1 : 0;
      this.cur = { fuel: tune.fuel, height: tune.height, thickness: tune.thickness, wildness: tune.wildness, colors: this.palette.map(rgb), alpha: 1 };
    }
  }

  resize(width: number, height: number, box: FireBox): void {
    this.dpr = window.devicePixelRatio || 1;
    this.over.width = Math.round(width * this.dpr);
    this.over.height = Math.round(height * this.dpr);
    this.front.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.width = width;
    this.height = height;
    this.box = box;
    this.sizeFire();
  }

  /** The fire canvas at the screen's resolution, or (pixel art) at one pixel per CELL, scaled up without smoothing. */
  private sizeFire(): void {
    const pixel = this.tune.style === 'pixel';
    this.fireScale = pixel ? 1 / CELL : this.dpr;
    this.behind.width = Math.max(1, Math.ceil(this.width * this.fireScale));
    this.behind.height = Math.max(1, Math.ceil(this.height * this.fireScale));
    this.behind.style.imageRendering = pixel ? 'pixelated' : '';
  }

  focus(on: boolean): void {
    this.focused = on;
  }

  /** A key typed at `caret`: the fire flares (and, only while typing, catches there once you keep on typing). */
  stoke(caret?: { x: number; y: number }): void {
    this.heat = Math.min(1, this.heat + 0.045);
    // A pause ends the run: the next key starts a new one, which has to warm up again.
    if (this.time - this.typedAt > RUN_GAP) {
      this.runAt = this.time;
      this.runKeys = 0;
    }
    this.runKeys++;
    this.typedAt = this.time;
    if (caret) this.caretAt = caret;
  }

  /** Confetti from the caret (or, `pixels`, little squares in the fire's colours). */
  burst({ x, y }: { x: number; y: number }, n = 9, pixels = false): void {
    const colors = [...this.palette, '#ffffff'];
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.95;
      const speed = 1.6 + Math.random() * 2.6;
      this.bits.push({
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 0.6,
        spin: Math.random() * Math.PI,
        turn: (Math.random() - 0.5) * 0.4,
        life: 1,
        color: pixels ? colors[(Math.random() * colors.length) | 0]! : CONFETTI[(Math.random() * CONFETTI.length) | 0]!,
        shape: pixels ? 3 : ((Math.random() * 3) as 0 | 1 | 2),
        size: pixels ? 3 : 0,
      });
    }
    if (this.bits.length > 400) this.bits.splice(0, this.bits.length - 400);
  }

  /** Characters deleted at the caret: each pops into a little shower of pixels that fall away. */
  pop({ x, y }: { x: number; y: number }, chars: number): void {
    const n = Math.min(60, 5 + chars * 5);
    const colors = [...this.palette, '#ffffff'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 2.2;
      this.bits.push({
        x: x - Math.random() * Math.min(chars, 12) * 7,
        y: y + (Math.random() - 0.5) * 8,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 1.6,
        spin: 0,
        turn: 0,
        life: 1,
        color: colors[(Math.random() * colors.length) | 0]!,
        shape: 3,
        size: Math.random() < 0.3 ? 4 : 3,
      });
    }
    if (this.bits.length > 400) this.bits.splice(0, this.bits.length - 400);
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(3, (now - this.last) / 16.67);
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.front.clearRect(0, 0, this.width, this.height);
    this.flame?.draw({ ...this.drawn(), rim: 0, blobs: [] });
  }

  /** Typing fast makes it lose its temper: orange instead of blue, until it calms down. */
  private get palette(): readonly [string, string, string] {
    return this.tune.temper && this.heat > 0.9 ? TEMPER : this.tune.colors;
  }

  /** Where a new blob of heat starts: mostly along the top edge, some up the sides (only as far as the fire has spread). */
  private spawn(): Blob | undefined {
    const { x, y, w, h } = this.box;
    let side = 0;
    let px = 0;
    let py = 0;
    for (let tries = 0; ; tries++) {
      const r = Math.random();
      side = r < 0.8 ? 0 : r < 0.9 ? -1 : 1;
      px = side === 0 ? x + 6 + Math.random() * (w - 12) : side < 0 ? x - 2 : x + w + 2;
      py = side === 0 ? y + 4 : y + 8 + Math.random() * (h - 12);
      if (Math.hypot(px - this.origin.x, py - this.origin.y) <= this.spread + SPREAD_FRONT) break;
      // Just caught: the first flames are above the caret.
      if (tries < 6) continue;
      side = 0;
      px = Math.min(x + w - 6, Math.max(x + 6, this.origin.x + (Math.random() - 0.5) * Math.min(Math.max(this.spread + SPREAD_FRONT, 10), 40)));
      py = y + 4;
      break;
    }
    const { thickness, height, wildness } = this.cur;
    const size = (side === 0 ? 5 + Math.random() * 6 : 4 + Math.random() * 3) * (0.6 + thickness * 0.9);
    const lift = 0.6 + height * 1.0;
    return { x: px, y: py, vx: side * (0.25 + Math.random() * 0.3) + (Math.random() - 0.5) * (0.1 + wildness * 0.5), vy: -(0.35 + Math.random() * 0.5) * lift, r: size * (0.8 + this.heat * 0.5), life: 1, decay: (0.012 + Math.random() * 0.012) * (1.5 - height * 0.9) };
  }

  private step(dt: number): void {
    this.time += dt / 60;
    // Glide toward the chosen look.
    const k = Math.min(1, 0.09 * dt);
    const cur = this.cur;
    for (const key of ['fuel', 'height', 'thickness', 'wildness'] as const) cur[key] += (this.tune[key] - cur[key]) * k;
    const toward = this.palette.map(rgb);
    cur.colors = cur.colors.map((c, i) => c.map((v, j) => v + (toward[i]![j]! - v) * k) as Rgb);
    cur.alpha += (1 - cur.alpha) * Math.min(1, 0.07 * dt);
    const target = this.focused ? 0.55 : 0.4;
    this.heat += (target - this.heat) * 0.02 * dt;
    // Only while typing: it catches once you keep on typing (a few keys, for `catchAfter`; at once
    // if that's 0), at the caret, and spreads from there round the box. `outAfter` after you stop,
    // the fuel runs out: no new flames, the base goes out quickly, and the last flames lift off the
    // box and burn out as they rise, like a real fire. A key before it's quite out feeds it again.
    const typing = this.tune.show === 'typing';
    const { catchAfter, outAfter } = this.tune;
    const keys = Math.min(WARM_KEYS, 1 + Math.round(catchAfter * 5));
    if (typing && !this.lit && this.time - this.typedAt < Math.min(RUN_GAP, outAfter) && this.runKeys >= keys && this.time - this.runAt >= catchAfter) {
      this.lit = true;
      // Still burning from before: it keeps its spread. Out: it starts again at the caret.
      if (this.amount < 0.05) {
        this.origin = { ...this.caretAt };
        const { x, y, w, h } = this.box;
        this.spreadTo = Math.max(Math.hypot(this.origin.x - x, this.origin.y - y), Math.hypot(x + w - this.origin.x, this.origin.y - y), Math.hypot(this.origin.x - x, y + h - this.origin.y), Math.hypot(x + w - this.origin.x, y + h - this.origin.y));
        this.spreadT = 0;
      }
    }
    if (this.lit && this.time - this.typedAt >= Math.max(RUN_GAP, outAfter)) this.lit = false;
    if (this.lit && this.spreadT < 1) this.spreadT = Math.min(1, this.spreadT + dt / 60 / (SPREAD_TIME + this.spreadTo * SPREAD_PER_PX));
    // The front starts just behind the caret (nothing yet) and ends past the farthest corner (all of it).
    this.spread = !typing || this.spreadT >= 1 ? Infinity : easeInOut(this.spreadT) * (this.spreadTo + SPREAD_FRONT * 2) - SPREAD_FRONT * 0.4;
    const goal = this.tune.show === 'off' ? 0 : typing ? (this.lit && this.time - this.typedAt < outAfter ? 1 : 0) : 1;
    const was = this.amount;
    this.amount += (goal - this.amount) * Math.min(1, (goal > this.amount ? 0.07 : 0.12) * dt);
    if (Math.abs(this.amount - was) > 0.004 || (goal !== was && Math.abs(goal - this.amount) < 0.004)) this.onBurn?.(this.amount);
    // Keep the fire fed: one blob per 12–30px of edge (the fuel), more the hotter it burns.
    const want = Math.min(MAX_BLOBS, Math.round(((this.box.w + this.box.h) / (30 - this.cur.fuel * 18)) * (0.7 + this.heat * 0.6) * this.amount));
    // Out of fuel, nothing new catches.
    for (let born = goal ? (want / 60) * dt * 1.4 : 0; born > 0 && this.blobs.length < want; born--) {
      if (born < 1 && Math.random() > born) break;
      const b = this.spawn();
      if (b) this.blobs.push(b);
    }
    for (const b of this.blobs) {
      // Rising faster as it goes (hot air), drifting, shrinking as it cools.
      // Out of fuel, the last flames lift off and rise away.
      b.vy -= (0.018 + (goal ? 0 : 0.05)) * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= 0.99;
      b.life -= b.decay * dt * (goal ? 1 : 1.6);
      b.r *= 1 - 0.006 * dt;
    }
    // Flames that drift near the edge of what can be seen burn out there.
    const clip = this.box.clip;
    if (clip) for (const b of this.blobs) if (Math.min(b.x - clip.x0, clip.x1 - b.x, b.y - clip.y0, clip.y1 - b.y) < 22) b.life -= 0.06 * dt;
    this.blobs = this.blobs.filter((b) => b.life > 0);
    for (const b of this.bits) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vy += 0.14 * dt;
      b.vx *= 0.985;
      b.spin += b.turn * dt;
      b.life -= 0.016 * dt;
    }
    this.bits = this.bits.filter((b) => b.life > 0);
  }

  private draw(): void {
    const pixel = this.tune.style === 'pixel';
    this.flame?.draw({ ...this.drawn(), blobs: this.blobs });
    this.drawConfetti(pixel);
  }

  /** What the shader is given, from the dials. */
  private drawn() {
    const { style } = this.tune;
    const { fuel, height, wildness, colors, alpha } = this.cur;
    return { width: this.width, height: this.height, dpr: this.fireScale, box: this.box, time: this.time, cell: style === 'pixel' ? CELL : 0, heat: this.heat, wild: wildness, tall: height, reach: this.box.y, rim: (0.55 + fuel * 0.8) * this.amount, spread: { ...this.origin, r: Number.isFinite(this.spread) ? this.spread + SPREAD_FRONT : 1e6 }, alpha, colors };
  }

  private drawConfetti(pixel: boolean): void {
    const g = this.front;
    g.clearRect(0, 0, this.width, this.height);
    for (const b of this.bits) {
      g.globalAlpha = Math.min(1, b.life * 2);
      g.fillStyle = b.color;
      if (b.shape === 3) {
        g.fillRect(Math.round(b.x / b.size) * b.size, Math.round(b.y / b.size) * b.size, b.size, b.size);
        continue;
      }
      // Pixel art: square bits on the fire's grid.
      if (pixel) {
        g.fillRect(Math.round(b.x / CELL) * CELL, Math.round(b.y / CELL) * CELL, CELL, CELL);
        continue;
      }
      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.spin);
      if (b.shape === 0) g.fillRect(-1.5, -3, 3, 6);
      else if (b.shape === 1) {
        g.beginPath();
        g.arc(0, 0, 1.8, 0, Math.PI * 2);
        g.fill();
      } else {
        g.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2;
          g.lineTo(Math.cos(a) * 3.2, Math.sin(a) * 3.2);
          g.lineTo(Math.cos(a + Math.PI / 4) * 1.1, Math.sin(a + Math.PI / 4) * 1.1);
        }
        g.fill();
      }
      g.restore();
    }
    g.globalAlpha = 1;
  }
}

/** Where the caret is in a textarea, relative to the textarea (a hidden copy of it, measured). */
export function caretPoint(el: HTMLTextAreaElement): { x: number; y: number } {
  const css = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const prop of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'] as const) {
    mirror.style[prop] = css[prop];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  mirror.textContent = el.value.slice(0, el.selectionEnd ?? el.value.length);
  const mark = document.createElement('span');
  mark.textContent = '​';
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const point = { x: mark.offsetLeft, y: mark.offsetTop - el.scrollTop + parseFloat(css.lineHeight || '20') / 2 };
  mirror.remove();
  return point;
}
