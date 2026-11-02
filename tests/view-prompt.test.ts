import { describe, expect, it } from 'vitest';
import { buildViewAppend } from '../src/agent/view-prompt.js';

/**
 * BLG-572: Claude added a code excerpt to a recap nobody asked to read, and its highlight was a
 * guess that marked the wrong lines. An excerpt is for when the code is the point, from the file as it is.
 */
describe('code excerpts in the prompt', () => {
  it.each([false, true])('only when the code is what’s needed, never to decorate a summary (terminal: %s)', (terminal) => {
    const said = buildViewAppend(terminal).replace(/\s+/g, ' ');
    expect(said).toContain('show lines only when the code itself is what the person needs to see');
    expect(said).toContain('never add code to a summary of finished work');
    expect(said).not.toMatch(/when you point at lines \(what you changed/);
  });

  it('line numbers come from the file as it is now', () => {
    expect(buildViewAppend().replace(/\s+/g, ' ')).toContain('Take the line numbers from the file as it is now (read it first), never from memory or a guess.');
  });
});
