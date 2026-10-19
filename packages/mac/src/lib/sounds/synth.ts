/**
 * A tiny synthesizer for notification sounds: notes in, mono samples out (pure functions, no
 * Web Audio), so the same sound plays in a preview, lands in a .wav for macOS, and is tested.
 */

export const SAMPLE_RATE = 44_100;
/** Loudest sample at full volume: moderate, with headroom (about -3 dBFS). */
export const PEAK = 0.7;
/**
 * Loudest stretch (50 ms RMS) at full volume, so a dense square-wave blip isn't louder than
 * a soft bell that reaches the same peak.
 */
export const LOUDNESS = 0.2;

export type Wave = 'square' | 'pulse' | 'triangle' | 'noise' | 'sine' | 'fm';

export interface Note {
  /** When it starts and how long it lasts (seconds, release included). */
  readonly at: number;
  readonly dur: number;
  readonly freq: number;
  /** Glide to this frequency over the note (Hz). */
  readonly to?: number;
  readonly wave: Wave;
  readonly gain?: number;
  /** Seconds; soft by default so nothing clicks. */
  readonly attack?: number;
  readonly release?: number;
  /** How fast it fades while held (per second, 0: not at all). */
  readonly decay?: number;
  /** FM bell: modulator ratio, depth (radians), and how fast the depth fades (per second). */
  readonly fm?: { readonly ratio: number; readonly index: number; readonly fade: number };
}

export interface SoundSpec {
  readonly notes: readonly Note[];
  /** Low-pass cutoff (Hz): takes the edge off square waves. */
  readonly lowpass: number;
  /** A small room: how much of it (0–1) and how long it rings (seconds). */
  readonly reverb?: { readonly mix: number; readonly time: number };
  /** Longest it may be (seconds), tail included. */
  readonly maxLength: number;
}

const TAU = Math.PI * 2;

/** PolyBLEP: rounds the jump of a square/pulse wave so it doesn't alias into a harsh buzz. */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** A deterministic noise source (an xorshift), so the same sound is the same every time. */
function noiseSource(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return (x / 0xffffffff) * 2 - 1;
  };
}

function envelope(t: number, n: Note): number {
  const attack = Math.max(0.003, n.attack ?? 0.005);
  const release = Math.min(n.dur, Math.max(0.01, n.release ?? 0.06));
  const rise = t < attack ? t / attack : 1;
  const left = n.dur - t;
  const fall = left < release ? 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, left)) / release) : 1;
  return rise * fall * Math.exp(-(n.decay ?? 0) * t);
}

/** Add one note into `out`. */
function addNote(out: Float32Array, n: Note, rate: number, index: number): void {
  const start = Math.round(n.at * rate);
  const length = Math.min(Math.round(n.dur * rate), out.length - start);
  const gain = n.gain ?? 1;
  const noise = noiseSource(index * 7919 + Math.round(n.freq));
  let phase = 0;
  let modPhase = 0;
  let held = 0;
  let heldPhase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const f = n.to ? n.freq * Math.pow(n.to / n.freq, t / n.dur) : n.freq;
    const dt = f / rate;
    let v: number;
    switch (n.wave) {
      case 'square':
      case 'pulse': {
        const width = n.wave === 'square' ? 0.5 : 0.25;
        // Minus its average (a narrow pulse sits below zero), so it doesn't push the speaker.
        v = (phase < width ? 1 : -1) + blep(phase, dt) - blep((phase - width + 1) % 1, dt) - (2 * width - 1);
        break;
      }
      case 'triangle':
        v = 1 - 4 * Math.abs(phase - 0.5);
        break;
      case 'noise':
        // Sample-and-hold noise at the note's pitch, like an old sound chip.
        heldPhase += dt;
        if (heldPhase >= 1 || i === 0) {
          heldPhase %= 1;
          held = noise();
        }
        v = held;
        break;
      case 'fm': {
        const fm = n.fm ?? { ratio: 2, index: 1, fade: 6 };
        const depth = fm.index * Math.exp(-fm.fade * t);
        v = Math.sin(TAU * phase + depth * Math.sin(TAU * modPhase));
        modPhase = (modPhase + dt * fm.ratio) % 1;
        break;
      }
      default:
        v = Math.sin(TAU * phase);
    }
    phase = (phase + dt) % 1;
    out[start + i]! += v * gain * envelope(t, n);
  }
}

/** A gentle 12 dB/octave low-pass (RBJ biquad, Q 0.707), in place. */
function lowpass(buf: Float32Array, cutoff: number, rate: number): void {
  const w = (TAU * Math.min(cutoff, rate * 0.45)) / rate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    buf[i] = y;
  }
}

/** Removes any offset from zero (a 20 Hz high-pass), in place. */
function dcBlock(buf: Float32Array, rate: number): void {
  const r = 1 - (TAU * 20) / rate;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    y1 = x - x1 + r * y1;
    x1 = x;
    buf[i] = y1;
  }
}

/** The loudest 50 ms of it (RMS). */
function loudest(buf: Float32Array, rate: number): number {
  const win = Math.max(1, Math.round(0.05 * rate));
  let best = 0;
  for (let start = 0; start < buf.length; start += Math.ceil(win / 4)) {
    let sum = 0;
    const end = Math.min(buf.length, start + win);
    for (let i = start; i < end; i++) sum += buf[i]! * buf[i]!;
    best = Math.max(best, Math.sqrt(sum / win));
  }
  return best;
}

/** A small Schroeder room: four combs into two all-passes, mixed under the dry sound. */
function reverb(buf: Float32Array, mix: number, time: number, rate: number): Float32Array<ArrayBuffer> {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => {
    const len = Math.round(s * rate);
    return { line: new Float32Array(len), at: 0, g: Math.pow(10, (-3 * s) / Math.max(0.1, time)) };
  });
  const passes = [0.005, 0.0017].map((s) => ({ line: new Float32Array(Math.round(s * rate)), at: 0 }));
  const out = new Float32Array(buf.length);
  let damp = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i]!;
    let wet = 0;
    for (const c of combs) {
      const y = c.line[c.at]!;
      c.line[c.at] = x + y * c.g;
      c.at = (c.at + 1) % c.line.length;
      wet += y;
    }
    wet /= combs.length;
    for (const p of passes) {
      const d = p.line[p.at]!;
      const y = -0.5 * wet + d;
      p.line[p.at] = wet + 0.5 * y;
      p.at = (p.at + 1) % p.line.length;
      wet = y;
    }
    damp += 0.35 * (wet - damp); // a darker tail
    out[i] = x * (1 - mix * 0.5) + damp * mix;
  }
  return out;
}

/** The finished sound at `volume` (0–1): filtered, roomy if asked, faded at the end, peak-limited. */
export function render(spec: SoundSpec, volume = 1, rate = SAMPLE_RATE): Float32Array<ArrayBuffer> {
  const end = Math.max(...spec.notes.map((n) => n.at + n.dur), 0.01);
  const tail = spec.reverb ? spec.reverb.time * 0.5 : 0.02;
  const length = Math.round(Math.min(spec.maxLength, end + tail) * rate);
  let buf = new Float32Array(length);
  spec.notes.forEach((n, i) => addNote(buf, n, rate, i));
  lowpass(buf, spec.lowpass, rate);
  dcBlock(buf, rate);
  if (spec.reverb && spec.reverb.mix > 0) buf = reverb(buf, spec.reverb.mix, spec.reverb.time, rate);
  const fade = Math.min(length, Math.round(0.03 * rate));
  for (let i = 0; i < fade; i++) buf[length - 1 - i]! *= i / fade;
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const level = Math.min(PEAK / Math.max(peak, 1e-9), LOUDNESS / Math.max(loudest(buf, rate), 1e-9));
  const scale = peak > 0 ? level * Math.min(1, Math.max(0, volume)) : 0;
  return buf.map((v) => v * scale);
}

/** Frequency of a MIDI note (69 = A4 = 440 Hz). */
export const midi = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);
