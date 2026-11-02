import { describe, expect, it } from 'vitest';
import { ASSISTANT_TITLE, assistantTitleFor, computerKindOf } from '../src/shared/assistant.js';

describe('Your Mac, Your Linux, Your Windows', () => {
  it('names your own Claude after the computer it runs on', () => {
    expect(computerKindOf('darwin')).toBe('mac');
    expect(computerKindOf('MacIntel Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(computerKindOf('win32')).toBe('windows');
    expect(computerKindOf('Win32 Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(computerKindOf('linux')).toBe('linux');
    expect(computerKindOf('Linux x86_64 Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(assistantTitleFor('linux')).toBe('Your Linux');
    expect(assistantTitleFor('windows')).toBe('Your Windows');
    // The tests are a Mac's wherever they run (tests/setup.ts).
    expect(ASSISTANT_TITLE).toBe('Your Mac');
  });
});
