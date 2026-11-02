import { describe, expect, it } from 'vitest';
import { FRAME, joinPhrases, PhraseCutter, PHRASE_RATE, promptFrom, Resampler } from '../src/shared/voice-phrases.js';

/** Phrases while you talk (BLG-160): cut at pauses, so each is written down while you keep talking. */
const sec = (s: number) => Math.round(s * PHRASE_RATE);
/** "Speech": a 200 Hz tone that rises and falls four times a second (syllables), over a little room noise. */
const talk = (s: number, level = 0.15) =>
  Float32Array.from({ length: sec(s) }, (_, i) => level * (0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / PHRASE_RATE)) * Math.sin((2 * Math.PI * 200 * i) / PHRASE_RATE) + (Math.random() - 0.5) * 0.004);
const quiet = (s: number, noise = 0.004) => Float32Array.from({ length: sec(s) }, () => (Math.random() - 0.5) * noise);
const feed = (c: PhraseCutter, ...parts: Float32Array[]) => parts.flatMap((p) => c.push(p));

describe('cutting phrases at pauses', () => {
  it('cuts after three seconds of quiet that follow enough speech, a breath after the words', () => {
    const c = new PhraseCutter();
    const cuts = feed(c, quiet(0.3), talk(1.5), quiet(3.4));
    expect(cuts).toHaveLength(1);
    const [cut] = cuts;
    expect(cut!.start).toBe(0);
    // It ends just after the talking (a breath of quiet), not in it and not long after.
    expect(cut!.end).toBeGreaterThan(sec(1.8));
    expect(cut!.end).toBeLessThan(sec(2.4));
    expect(cut!.speechMs).toBeGreaterThan(1300);
  });

  it('waits for someone thinking aloud: pauses under three seconds keep one phrase', () => {
    const c = new PhraseCutter();
    const cuts = feed(c, talk(0.8), quiet(1.2), talk(0.6), quiet(2.6), talk(1), quiet(0.4), talk(0.7), quiet(3.3));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.speechMs).toBeGreaterThan(2400);
  });

  it('cuts each thought once; only the silence between them is left out', () => {
    const c = new PhraseCutter();
    const cuts = feed(c, talk(1), quiet(0.5), talk(1), quiet(3.3), talk(1.2), quiet(3.3));
    expect(cuts).toHaveLength(2);
    // The second starts after the first, within the quiet between them (no words skipped).
    expect(cuts[1]!.start).toBeGreaterThanOrEqual(cuts[0]!.end);
    expect(cuts[1]!.start).toBeLessThanOrEqual(sec(2.5 + 3.3));
    expect(cuts[1]!.speechMs).toBeGreaterThan(900);
  });

  it('leaves a cough for the next phrase rather than writing it down alone', () => {
    const c = new PhraseCutter();
    const cuts = feed(c, talk(0.1), quiet(3.4), talk(1), quiet(3.4));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.speechMs).toBeGreaterThan(900);
  });

  it('cuts a long run-on phrase at its quietest recent moment', () => {
    const c = new PhraseCutter({ maxPhraseMs: 6000 });
    const cuts = feed(c, talk(3), talk(0.3, 0.03), talk(3));
    expect(cuts).toHaveLength(1);
    // Inside the softer stretch (3.0–3.3 s).
    expect(cuts[0]!.end).toBeGreaterThanOrEqual(sec(2.95));
    expect(cuts[0]!.end).toBeLessThanOrEqual(sec(3.35));
  });

  it('hears speech over a noisy room (the floor rises with the noise)', () => {
    const c = new PhraseCutter();
    const cuts = feed(c, quiet(2, 0.04), talk(1.5, 0.25), quiet(3.4, 0.04));
    expect(cuts).toHaveLength(1);
  });

  it('gives what is left when you stop, unless it is only quiet', () => {
    const c = new PhraseCutter();
    feed(c, talk(1), quiet(0.2));
    const last = c.end();
    expect(last).toMatchObject({ start: 0 });
    expect(last!.end).toBeGreaterThanOrEqual(sec(1.2) - FRAME);
    const silent = new PhraseCutter();
    feed(silent, quiet(1));
    expect(silent.end()).toBeUndefined();
  });

  it('reports a level and whether you are speaking, for the animation', () => {
    const c = new PhraseCutter();
    feed(c, quiet(0.5), talk(0.3));
    expect(c.speaking).toBe(true);
    expect(c.level).toBeGreaterThan(0.5);
  });
});

describe('putting the phrases together', () => {
  it('joins written phrases in order, without spaces before punctuation', () => {
    expect(joinPhrases(['Fix the login', undefined, ' and add a test ', '.'])).toBe('Fix the login and add a test.');
  });
  it("tells Whisper the last words before, starting on a whole word", () => {
    expect(promptFrom('')).toBeUndefined();
    expect(promptFrom('Fix the login')).toBe('Fix the login');
    const long = `${'word '.repeat(60)}end`;
    const p = promptFrom(long)!;
    expect(p.length).toBeLessThanOrEqual(200);
    expect(p.startsWith('word')).toBe(true);
    expect(p.endsWith('end')).toBe(true);
  });
});

describe('the microphone at its own rate', () => {
  it('comes out at 16 kHz in any chunk sizes, without drifting', () => {
    for (const rate of [48_000, 44_100]) {
      const r = new Resampler(rate);
      const second = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 100 * i) / rate));
      let n = 0;
      for (let i = 0; i < second.length; i += 1000 + (i % 7)) n += r.push(second.subarray(i, i + 1000 + (i % 7))).length;
      expect(Math.abs(n - PHRASE_RATE)).toBeLessThanOrEqual(1);
    }
    expect(new Resampler(16_000).push([0.1, 0.2])).toEqual(Float32Array.from([0.1, 0.2]));
  });
});
