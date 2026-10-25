/**
 * Phrases while you talk (BLG-160): the recording is cut at your pauses, so each phrase is written
 * down while you keep talking, and the words are ready the moment you stop. The phone (to the Mac,
 * or on the phone) and the Mac app both feed it 16 kHz samples as they come. No imports, runs anywhere.
 *
 * How it hears a pause: it keeps the room's noise floor (the quietest moment of the last few seconds:
 * speech dips between syllables, so that's the room even while you talk), calls a frame speech when
 * it's clearly above that, and cuts once a phrase with enough speech in it
 * is followed by a long enough quiet. A phrase that runs on is cut at its quietest recent moment.
 */

export const PHRASE_RATE = 16_000;
/** One frame of judgement: 30 ms. */
export const FRAME = (PHRASE_RATE * 30) / 1000;

export interface PhraseTuning {
  /** Quiet this long after speech ends a phrase (ms). */
  readonly pauseMs: number;
  /** A phrase needs at least this much speech to be cut on its own (ms); shorter ones wait for the next. */
  readonly minSpeechMs: number;
  /** A phrase is cut by force at this length (ms), at its quietest recent moment. */
  readonly maxPhraseMs: number;
  /** Speech is this many times the noise floor, and at least `minLevel` (RMS). */
  readonly overFloor: number;
  readonly minLevel: number;
}

/**
 * Three seconds of quiet ends a phrase: someone thinking aloud ("I want to… fix the login") keeps one
 * phrase, so it's written down as one sentence. A pause never stops the recording; it only sends
 * what came before it to be written down while you go on.
 */
export const DEFAULT_PHRASES: PhraseTuning = { pauseMs: 3000, minSpeechMs: 450, maxPhraseMs: 30_000, overFloor: 2.6, minLevel: 0.012 };

/** A phrase cut out of the recording: samples [start, end) of everything heard so far. */
export interface Cut {
  readonly start: number;
  readonly end: number;
  /** Speech in it (ms): a phrase of noise has none and needn't be written down. */
  readonly speechMs: number;
}

/** The noise floor is the quietest frame of the last 3 s. */
const FLOOR_FRAMES = 100;
/** A phrase keeps this much of the quiet after it (0.36 s): a breath, not a silence. */
const BREATH_FRAMES = 12;
const ms = (frames: number): number => (frames * FRAME * 1000) / PHRASE_RATE;

export class PhraseCutter {
  private readonly t: PhraseTuning;
  /** Samples heard so far (the next frame starts at `heard - pending.length`). */
  private heard = 0;
  private pending: number[] = [];
  /** Where the phrase being heard starts (a sample index). */
  private phraseStart = 0;
  private speechFrames = 0;
  private quietFrames = 0;
  /** The last few seconds of frame levels: the quietest is the room's noise floor. */
  private recent: number[] = [];
  /** Each frame's level since the phrase started, for the quietest moment of a long phrase. */
  private levels: number[] = [];
  /** The last frame's level and whether it was speech (for the listening animation). */
  level = 0;
  speaking = false;
  /** Called for every frame (30 ms): its level (0–1) and whether it was speech, for a waveform. */
  onFrame: ((level: number, speaking: boolean) => void) | undefined;

  constructor(tuning: Partial<PhraseTuning> = {}) {
    this.t = { ...DEFAULT_PHRASES, ...tuning };
  }

  /** More samples (floats in [-1, 1]) → the phrases they finished, if any. */
  push(samples: ArrayLike<number>): Cut[] {
    const cuts: Cut[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.pending.push(samples[i]!);
      if (this.pending.length < FRAME) continue;
      const cut = this.frame(this.pending);
      this.pending = [];
      if (cut) cuts.push(cut);
    }
    return cuts;
  }

  /** The recording stopped: what's left is the last phrase (undefined when it holds no speech). */
  end(): Cut | undefined {
    this.heard += this.pending.length;
    this.pending = [];
    const cut = { start: this.phraseStart, end: this.heard, speechMs: ms(this.speechFrames) };
    this.phraseStart = this.heard;
    this.speechFrames = 0;
    return cut.end > cut.start && cut.speechMs > 0 ? cut : undefined;
  }

  private frame(f: number[]): Cut | undefined {
    let sum = 0;
    for (const s of f) sum += s * s;
    const rms = Math.sqrt(sum / f.length);
    this.heard += f.length;
    this.recent.push(rms);
    if (this.recent.length > FLOOR_FRAMES) this.recent.shift();
    const threshold = Math.max(this.t.minLevel, Math.min(...this.recent) * this.t.overFloor);
    const speech = rms > threshold;
    this.level = Math.min(1, Math.sqrt(rms / 0.2));
    this.speaking = speech;
    this.onFrame?.(this.level, speech);
    this.levels.push(rms);
    if (speech) {
      this.speechFrames++;
      this.quietFrames = 0;
    } else this.quietFrames++;

    const length = ms(this.levels.length);
    // A pause after enough speech: the phrase ends a breath after the quiet began (a long tail of
    // silence makes the models guess at words that weren't said).
    if (!speech && ms(this.quietFrames) >= this.t.pauseMs && ms(this.speechFrames) >= this.t.minSpeechMs) {
      const keep = Math.max(0, this.quietFrames - BREATH_FRAMES);
      return this.cutAt(this.heard - keep * FRAME);
    }
    // Quiet with too little speech for a phrase of its own (a cough, a click): drop it from the start.
    if (!speech && this.speechFrames === 0 && length > 2000) {
      this.phraseStart = this.heard - FRAME * 8;
      this.levels = this.levels.slice(-8);
    }
    // Talking on without a pause: cut at the quietest frame of the last few seconds.
    if (length >= this.t.maxPhraseMs) {
      const look = Math.min(this.levels.length, Math.round(3000 / ms(1)));
      let at = this.levels.length - 1;
      for (let i = this.levels.length - look; i < this.levels.length; i++) if (this.levels[i]! < this.levels[at]!) at = i;
      return this.cutAt(this.phraseStart + (at + 1) * FRAME);
    }
    return undefined;
  }

  private cutAt(end: number): Cut {
    const start = this.phraseStart;
    const framesIn = Math.max(0, Math.round((end - start) / FRAME));
    const cut = { start, end, speechMs: ms(this.speechFrames) };
    this.phraseStart = end;
    // What's after the cut belongs to the next phrase.
    this.levels = this.levels.slice(framesIn);
    this.speechFrames = 0;
    this.quietFrames = this.levels.length;
    return cut;
  }
}

/** The words so far, in order: written phrases joined, waiting ones left out. */
export function joinPhrases(texts: readonly (string | undefined)[]): string {
  return texts
    .filter((t): t is string => Boolean(t?.trim()))
    .map((t) => t.trim())
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1');
}

/** What Whisper is told came before (keeps names and style across phrases): the last ~200 characters. */
export function promptFrom(before: string): string | undefined {
  const t = before.trim();
  if (!t) return undefined;
  return t.length <= 200 ? t : t.slice(t.length - 200).replace(/^\S*\s/, '');
}

/** The microphone's rate → 16 kHz as the samples come (each output the mean of the input it covers; no drift between chunks). */
export class Resampler {
  private readonly ratio: number;
  /** Input not yet used up, and where in it the next output sample starts (fractional). */
  private carry: number[] = [];
  private pos = 0;

  constructor(rate: number, to = PHRASE_RATE) {
    this.ratio = rate / to;
  }

  push(input: ArrayLike<number>): Float32Array {
    if (this.ratio === 1) return Float32Array.from(input);
    const buf = this.carry.length ? this.carry.concat(Array.from(input)) : Array.from(input);
    const out: number[] = [];
    while (this.pos + this.ratio <= buf.length) {
      const from = Math.floor(this.pos);
      const end = Math.max(from + 1, Math.floor(this.pos + this.ratio));
      let sum = 0;
      for (let j = from; j < end; j++) sum += buf[j]!;
      out.push(sum / (end - from));
      this.pos += this.ratio;
    }
    const drop = Math.floor(this.pos);
    this.carry = buf.slice(drop);
    this.pos -= drop;
    return Float32Array.from(out);
  }
}
