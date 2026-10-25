import { describe, expect, it } from 'vitest';
import { appendSpoken, cleanTranscript, joinPcm, MAX_BYTES, pcmLevel } from '../packages/companion/lib/dictate.js';

/** The Ask sheet's microphone: what the on-device Whisper writes, into the field (packages/companion/lib/dictate.ts). */
describe('phone dictation', () => {
  it('keeps the words and drops what Whisper says about the sound', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('(music) Run the tests  [ Silence ] and send me a screenshot ♪')).toBe('Run the tests and send me a screenshot');
    expect(cleanTranscript('*coughs* Fix the login')).toBe('Fix the login');
  });

  it('adds the words after what you wrote, with one space', () => {
    expect(appendSpoken('', ' Fix the login')).toBe('Fix the login');
    expect(appendSpoken('  ', 'Fix the login')).toBe('Fix the login');
    expect(appendSpoken('Hi.', 'Fix the login')).toBe('Hi. Fix the login');
    expect(appendSpoken('Hi. ', 'Fix the login')).toBe('Hi. Fix the login');
    expect(appendSpoken('Hi.\n', 'Fix the login')).toBe('Hi.\nFix the login');
    expect(appendSpoken('Hi.', '[BLANK_AUDIO]')).toBe('Hi.');
  });

  it('joins the recording, capped at two minutes and whole samples', () => {
    expect([...joinPcm([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])]).toEqual([1, 2, 3, 4]);
    expect(joinPcm([new Uint8Array(MAX_BYTES), new Uint8Array(100)]).length).toBe(MAX_BYTES);
  });

  it('hears silence as 0 and speech as louder', () => {
    expect(pcmLevel(new Uint8Array(0))).toBe(0);
    expect(pcmLevel(new Uint8Array(512))).toBe(0);
    const loud = new Int16Array(256).map((_, i) => (i % 2 ? 8000 : -8000));
    const soft = new Int16Array(256).map((_, i) => (i % 2 ? 300 : -300));
    const l = pcmLevel(new Uint8Array(loud.buffer));
    expect(l).toBeGreaterThan(pcmLevel(new Uint8Array(soft.buffer)));
    expect(l).toBeLessThanOrEqual(1);
  });
});
