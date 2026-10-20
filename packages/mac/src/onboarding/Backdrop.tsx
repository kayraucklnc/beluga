import { type RefObject, useEffect, useRef } from 'react';

/**
 * The onboarding's backdrop: slow folds of silk lit from above, a little copper in the light,
 * film grain on top. One fragment shader on the GPU (WebGL2, no library). It follows the theme
 * (easing from one to the other when you pick another), leans a touch toward the pointer, and
 * holds still for Reduce Motion. Without WebGL the CSS gradient under it is what you see.
 */

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 res;
uniform float t;
uniform vec2 lean;
uniform vec3 base;
uniform vec3 lit;
uniform vec3 tint;
uniform float energy;
out vec4 color;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 q = (gl_FragCoord.xy - 0.5 * res) / res.y + lean * 0.04;
  float s = t * 0.035;
  // Domain warping: noise displacing noise, which folds the field like cloth.
  vec2 w = vec2(fbm(q * 1.2 + vec2(0.0, s)), fbm(q * 1.2 + vec2(5.2, -s)));
  float f = fbm(q * 1.6 + 2.2 * w + vec2(s * 0.6, 0.0));
  float folds = smoothstep(0.35, 0.95, f);
  float sheen = pow(smoothstep(0.55, 0.98, f), 3.0);
  // Light from the top; the bottom falls away into the base.
  float fromTop = smoothstep(-0.45, 1.0, uv.y);
  vec3 c = mix(base, lit, folds * 0.85 * fromTop * energy);
  c = mix(c, tint, sheen * 0.32 * energy * fromTop);
  float vignette = smoothstep(1.25, 0.2, length(q * vec2(0.9, 1.1)));
  c = mix(base, c, mix(0.6, 1.0, vignette));
  // Grain, so the gradient never bands on a wide-gamut display.
  c += (hash(gl_FragCoord.xy + fract(t)) - 0.5) * 0.018;
  color = vec4(c, 1.0);
}`;

type Rgb = readonly [number, number, number];
interface Palette {
  readonly base: Rgb;
  readonly lit: Rgb;
  readonly tint: Rgb;
}

const PALETTES: Record<'light' | 'dark', Palette> = {
  dark: { base: [0.06, 0.06, 0.07], lit: [0.5, 0.5, 0.56], tint: [0.87, 0.58, 0.42] },
  light: { base: [0.97, 0.97, 0.975], lit: [0.72, 0.72, 0.77], tint: [0.88, 0.62, 0.47] },
};

const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | undefined {
  const shader = gl.createShader(type);
  if (!shader) return undefined;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return undefined;
}

function program(gl: WebGL2RenderingContext): WebGLProgram | undefined {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return undefined;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : undefined;
}

export interface BackdropProps {
  readonly theme: 'light' | 'dark';
  /** How much light is in the folds (0–1): brighter on the welcome, quieter behind settings. */
  readonly energy: number;
  readonly still: boolean;
  /** Hidden behind something (the wormhole): stop drawing, but keep the GPU context (tearing it down stalls a frame). */
  readonly paused?: boolean;
  /** The canvas, for glass that bends what's behind it (Glass.tsx). */
  readonly canvasRef?: RefObject<HTMLCanvasElement | null>;
}

export function Backdrop({ theme, energy, still, paused = false, canvasRef }: BackdropProps) {
  const own = useRef<HTMLCanvasElement>(null);
  const canvas = canvasRef ?? own;
  // What the next frame should ease toward (the effect below reads these without restarting).
  const target = useRef({ theme, energy, still, paused });
  target.current = { theme, energy, still, paused };

  useEffect(() => {
    const el = canvas.current;
    const gl = el?.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: true });
    if (!el || !gl) return;
    const prog = program(gl);
    if (!prog) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, name);
    const [uRes, uT, uLean, uBase, uLit, uTint, uEnergy] = ['res', 't', 'lean', 'base', 'lit', 'tint', 'energy'].map(u);

    // Rendered below Retina resolution (about 1.1 pixels a point at most): soft folds don't need it, the battery does.
    const resize = (): void => {
      const scale = Math.min(window.devicePixelRatio, 1.5) * 0.75;
      el.width = Math.max(1, Math.round(el.clientWidth * scale));
      el.height = Math.max(1, Math.round(el.clientHeight * scale));
      gl.viewport(0, 0, el.width, el.height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);

    const pointer = { x: 0, y: 0 };
    const onMove = (e: PointerEvent): void => {
      pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.y = (0.5 - e.clientY / window.innerHeight) * 2;
    };
    window.addEventListener('pointermove', onMove);

    let palette: Palette = PALETTES[target.current.theme];
    let shownEnergy = target.current.energy;
    const lean = { x: 0, y: 0 };
    let time = 20;
    let last = performance.now();
    let frame = 0;
    const draw = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const want = target.current;
      if (want.paused) {
        frame = requestAnimationFrame(draw);
        return;
      }
      if (!want.still) time += dt;
      // Ease every input toward its target, frame-rate independent.
      const k = 1 - Math.exp(-dt * 3.2);
      const goal = PALETTES[want.theme];
      palette = { base: mixRgb(palette.base, goal.base, k), lit: mixRgb(palette.lit, goal.lit, k), tint: mixRgb(palette.tint, goal.tint, k) };
      shownEnergy += (want.energy - shownEnergy) * k;
      lean.x += (pointer.x - lean.x) * k * 0.5;
      lean.y += (pointer.y - lean.y) * k * 0.5;
      gl.uniform2f(uRes!, el.width, el.height);
      gl.uniform1f(uT!, time);
      gl.uniform2f(uLean!, want.still ? 0 : lean.x, want.still ? 0 : lean.y);
      gl.uniform3fv(uBase!, palette.base);
      gl.uniform3fv(uLit!, palette.lit);
      gl.uniform3fv(uTint!, palette.tint);
      gl.uniform1f(uEnergy!, shownEnergy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    el.dataset.ready = 'true';
    // The GPU reset (sleep, a driver update): stop drawing and let the CSS gradient underneath show.
    const lost = (e: Event): void => {
      e.preventDefault();
      cancelAnimationFrame(frame);
      el.style.opacity = '0';
    };
    el.addEventListener('webglcontextlost', lost);

    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('webglcontextlost', lost);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, []);

  return <canvas ref={canvas} aria-hidden="true" data-backdrop style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />;
}
