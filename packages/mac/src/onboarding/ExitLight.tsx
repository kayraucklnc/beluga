import { type RefObject, useEffect, useRef } from 'react';

/**
 * The light at the end of the wormhole, alive: a white core that breathes, an edge that wobbles
 * like a blob, warm halo, and rays turning slowly round it. It sits wherever the tunnel's far end
 * is (`end`, kept up to date by the tunnel each frame), and grows from a spark to everything as
 * you fall toward it. One fragment shader (WebGL2), drawn below full resolution.
 */

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 res;
uniform vec2 center;   // px, origin bottom-left
uniform float t;
uniform float r;       // the core's radius, px
uniform float glow;    // 0 to 1
out vec4 color;

float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 q) {
  vec2 i = floor(q), f = fract(q);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 q) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(q); q = q * 2.07 + 3.1; a *= 0.5; }
  return v;
}
mat2 turn(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  vec2 d = gl_FragCoord.xy - center;
  float dist = length(d);
  // Direction round the light (no angle, so no seam where atan wraps), turning slowly.
  vec2 dir = turn(t * 0.25) * (d / max(dist, 1e-3));

  // The edge breathes and wobbles: noise round the rim, a slow pulse.
  float wob = 1.0 + 0.28 * (fbm(dir * 1.8 + vec2(t * 0.55, -t * 0.4)) - 0.5) + 0.06 * sin(t * 4.2);
  float rr = r * wob;
  float core = exp(-pow(dist / rr, 2.0) * 2.4);
  float halo = exp(-dist / (rr * 1.7)) * 0.65;

  // Rays: two sets of streaks round the light, one wide and slow, one fine and quick.
  float wide = pow(fbm(dir * 3.2 + vec2(t * 0.35, 0.0)), 2.2);
  float fine = pow(noise(turn(-t * 0.6) * dir * 11.0 + vec2(0.0, t * 0.8)), 5.0);
  float rays = (wide * 1.3 + fine * 0.9) * exp(-dist / (rr * 3.4)) * smoothstep(rr * 0.25, rr * 1.1, dist);

  vec3 white = vec3(1.0, 0.985, 0.96);
  vec3 peach = vec3(1.0, 0.8, 0.66);
  vec3 copper = vec3(0.92, 0.52, 0.36);
  vec3 c = white * core + mix(peach, copper, smoothstep(rr * 0.5, rr * 2.8, dist)) * (halo + rays);
  c *= glow;
  float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  color = vec4(min(c, vec3(1.0)), a);
}`;

function build(gl: WebGL2RenderingContext): WebGLProgram | undefined {
  const shader = (type: number, src: string): WebGLShader | undefined => {
    const s = gl.createShader(type);
    if (!s) return undefined;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : undefined;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return undefined;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : undefined;
}

/** Where the light is and how big, in CSS pixels from the top left; written by the wormhole each frame. */
export interface LightAt {
  x: number;
  y: number;
  /** The core's radius. */
  r: number;
  /** How lit (0 to 1). */
  glow: number;
}

const SCALE = 0.75;

export function ExitLight({ at }: { readonly at: RefObject<LightAt> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const gl = el?.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true });
    if (!el || !gl) return;
    const prog = build(gl);
    if (!prog) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, n);
    const uRes = u('res');
    const uCenter = u('center');
    const uT = u('t');
    const uR = u('r');
    const uGlow = u('glow');
    const resize = (): void => {
      el.width = Math.round(el.clientWidth * SCALE);
      el.height = Math.round(el.clientHeight * SCALE);
      gl.viewport(0, 0, el.width, el.height);
      gl.uniform2f(uRes, el.width, el.height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    const start = performance.now();
    let frame = 0;
    const draw = (now: number): void => {
      const a = at.current;
      if (a.glow > 0.001) {
        gl.uniform2f(uCenter, a.x * SCALE, el.height - a.y * SCALE);
        gl.uniform1f(uT, (now - start) / 1000);
        gl.uniform1f(uR, a.r * SCALE);
        gl.uniform1f(uGlow, a.glow);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      } else {
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    };
  }, []);
  return <canvas ref={canvas} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />;
}
