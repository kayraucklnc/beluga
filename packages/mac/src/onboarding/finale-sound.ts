/**
 * The wormhole's sound, made on the spot with Web Audio (no file to ship): a choir singing
 * "aah" that swells as you travel, air rushing past and rising, and as you come out into the
 * light the choir opens up an octave with a shimmer of bells, all in a long reverb, then fades.
 *
 * The voices are formant synthesis: bright sawtooth tones through the band-pass filters of an
 * open "ah" vowel, gently detuned against each other with a slow vibrato, which is what makes
 * them read as voices rather than synth pads. Quiet, and only after a click (so it may play).
 *
 * Building the hall's reverb takes a moment (~0.2 s of the main thread), so it's prepared while
 * the last step sits there, and the click only starts it.
 */

/** An open "ah": the vowel's resonances (Hz) and how loud each is. */
const AH: ReadonlyArray<{ hz: number; gain: number; q: number }> = [
  { hz: 800, gain: 1, q: 9 },
  { hz: 1150, gain: 0.5, q: 11 },
  { hz: 2900, gain: 0.18, q: 14 },
];

/** D major with a ninth, spread like a choir: low voices first, the high ones join in the light. */
const CHOIR = [146.83, 220.0, 293.66, 369.99, 440.0];
const LIGHT = [587.33, 739.99, 880.0, 1318.51];
const BELLS = [1760.0, 2217.46, 2637.02];

/** A long hall: decaying stereo noise to convolve with. */
function hall(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.ceil(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6;
  }
  return buffer;
}

function noise(ctx: AudioContext, seconds: number): AudioBufferSourceNode {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  return src;
}

/** One singer on one note, from `at` to `until`, swelling in over `attack`, its own vibrato and pan. */
function voice(ctx: AudioContext, out: AudioNode, hz: number, at: number, attack: number, until: number, level: number): void {
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(level, at + attack);
  amp.gain.setValueAtTime(level, until - 2.6);
  amp.gain.exponentialRampToValueAtTime(0.0001, until);
  const pan = ctx.createStereoPanner();
  pan.pan.value = Math.random() * 1.2 - 0.6;
  const vowel = ctx.createGain();
  for (const f of AH) {
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = f.hz;
    band.Q.value = f.q;
    const g = ctx.createGain();
    g.gain.value = f.gain;
    vowel.connect(band).connect(g).connect(amp);
  }
  amp.connect(pan).connect(out);
  // Three slightly different singers per note make it a section, not one voice.
  for (const cents of [-7, 0, 6]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = hz;
    osc.detune.value = cents;
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.6 + Math.random() * 0.8;
    const depth = ctx.createGain();
    depth.gain.value = 9;
    vibrato.connect(depth).connect(osc.detune);
    osc.connect(vowel);
    osc.start(at);
    vibrato.start(at);
    osc.stop(until + 0.05);
    vibrato.stop(until + 0.05);
  }
}

/** A soft bell: a sine that rings out. */
function bell(ctx: AudioContext, out: AudioNode, hz: number, at: number, level: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 2.4);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + 2.5);
}

export interface Prepared {
  /** `light`: when you reach the light (s from now); `end`: when the app is there. It rings on over the app. */
  play(light: number, end: number): void;
  /** Not needed after all (the welcome went another way). */
  discard(): void;
}

export function prepareWormhole(volume = 0.3): Prepared | undefined {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return undefined;
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return undefined;
  }
  const master = ctx.createGain();
  master.gain.value = volume;
  const limiter = ctx.createDynamicsCompressor();
  master.connect(limiter).connect(ctx.destination);
  const reverb = ctx.createConvolver();
  reverb.buffer = hall(ctx, 4.5);
  const wet = ctx.createGain();
  wet.gain.value = 0.85;
  const dry = ctx.createGain();
  dry.gain.value = 0.45;
  const bus = ctx.createGain();
  bus.connect(dry).connect(master);
  bus.connect(reverb).connect(wet).connect(master);
  const rush = noise(ctx, 4);
  const close = (): void => void ctx.close().catch(() => undefined);

  return {
    discard: close,
    play(light, end) {
      void ctx.resume().catch(() => undefined);
      const t0 = ctx.currentTime + 0.03;
      const tail = t0 + end + 3.2;
      // The choir swells as you fall in.
      CHOIR.forEach((hz, i) => voice(ctx, bus, hz, t0 + i * 0.12, 1.8, tail, 0.16));
      // In the light it opens up, higher, with bells.
      LIGHT.forEach((hz, i) => voice(ctx, bus, hz, t0 + light - 0.35 + i * 0.08, 0.9, tail, 0.11));
      BELLS.forEach((hz, i) => bell(ctx, bus, hz, t0 + light + i * 0.16, 0.05));
      // The air rushing past, rising with the speed, gone in the light.
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 0.8;
      band.frequency.setValueAtTime(220, t0);
      band.frequency.exponentialRampToValueAtTime(2600, t0 + light);
      const rushGain = ctx.createGain();
      rushGain.gain.setValueAtTime(0.0001, t0);
      rushGain.gain.exponentialRampToValueAtTime(0.22, t0 + light - 0.1);
      rushGain.gain.exponentialRampToValueAtTime(0.0001, t0 + light + 0.6);
      rush.connect(band).connect(rushGain).connect(bus);
      rush.start(t0);
      setTimeout(close, (end + 7.5) * 1000);
    },
  };
}
