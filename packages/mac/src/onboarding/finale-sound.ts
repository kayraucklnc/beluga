/**
 * The finale's sound, made on the spot with Web Audio (no file to ship): a breath drawn in while
 * the light gathers, then the bang: a deep thump with a rush of air that falls away. Quiet, and
 * only ever after you clicked, so the window is allowed to play it.
 */

/** When the bang lands after the gather starts (s); the finale's light bursts at the same moment. */
export const BANG_AT = 0.38;

function noise(ctx: AudioContext, seconds: number): AudioBufferSourceNode {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  return src;
}

export function playFinale(volume = 0.32): void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return;
  }
  const t0 = ctx.currentTime + 0.02;
  const bang = t0 + BANG_AT;
  const master = ctx.createGain();
  master.gain.value = volume;
  const limiter = ctx.createDynamicsCompressor();
  master.connect(limiter).connect(ctx.destination);

  // The breath in: air through a band that rises and swells toward the bang.
  const breath = noise(ctx, BANG_AT + 0.05);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.4;
  band.frequency.setValueAtTime(350, t0);
  band.frequency.exponentialRampToValueAtTime(3200, bang);
  const breathGain = ctx.createGain();
  breathGain.gain.setValueAtTime(0.0001, t0);
  breathGain.gain.exponentialRampToValueAtTime(0.35, bang - 0.02);
  breathGain.gain.exponentialRampToValueAtTime(0.0001, bang + 0.03);
  breath.connect(band).connect(breathGain).connect(master);
  breath.start(t0);

  // The thump: a sine dropping from a knock to a rumble.
  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(150, bang);
  thump.frequency.exponentialRampToValueAtTime(38, bang + 0.45);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.0001, bang);
  thumpGain.gain.exponentialRampToValueAtTime(1, bang + 0.008);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, bang + 0.7);
  thump.connect(thumpGain).connect(master);
  thump.start(bang);
  thump.stop(bang + 0.75);

  // The rush: bright air that darkens as it spreads out.
  const rush = noise(ctx, 1.3);
  const low = ctx.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.setValueAtTime(7000, bang);
  low.frequency.exponentialRampToValueAtTime(220, bang + 1.1);
  const rushGain = ctx.createGain();
  rushGain.gain.setValueAtTime(0.0001, bang);
  rushGain.gain.exponentialRampToValueAtTime(0.5, bang + 0.012);
  rushGain.gain.exponentialRampToValueAtTime(0.0001, bang + 1.2);
  rush.connect(low).connect(rushGain).connect(master);
  rush.start(bang);

  setTimeout(() => void ctx.close().catch(() => undefined), (BANG_AT + 1.6) * 1000);
}
