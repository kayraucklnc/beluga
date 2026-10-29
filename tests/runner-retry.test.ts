import { describe, expect, it } from 'vitest';
import { retryWords } from '../src/agent/runner.js';

/** Claude Code retrying the API shows on the working line instead of a silent "Starting" (BLG-403). */
describe('retryWords', () => {
  it('says why, and which retry, in at most 40 characters', () => {
    expect(retryWords(529, 2, 10)).toBe('Claude is busy, retry 2 of 10');
    expect(retryWords(429, 1, 10)).toBe('Rate limited, retry 1 of 10');
    expect(retryWords(null, 3, 10)).toBe('No answer from Claude, retry 3 of 10');
    expect(retryWords(200, 1, 1, true)).toBe('No answer from Claude, retry 1 of 1');
    expect(retryWords(400, 1, 10)).toBe('API error 400, retry 1 of 10');
    for (const s of [529, 429, null, 400]) expect(retryWords(s, 10, 10).length).toBeLessThanOrEqual(40);
  });
});
