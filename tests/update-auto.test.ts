import { describe, expect, it } from 'vitest';
import { modeOf, switchesOf } from '../packages/mac/src/lib/update-model.js';

describe('the Mac app’s two switches', () => {
  it('Update automatically and Check for updates, as the mode the app shell keeps', () => {
    expect(switchesOf('idle')).toEqual({ auto: true, check: true });
    expect(switchesOf('ask')).toEqual({ auto: false, check: true });
    expect(switchesOf('off')).toEqual({ auto: false, check: false });
    expect(modeOf({ auto: true }, 'ask')).toBe('idle');
    expect(modeOf({ auto: false }, 'idle')).toBe('ask');
    // Updating automatically needs looking; not looking turns it off.
    expect(modeOf({ auto: true }, 'off')).toBe('idle');
    expect(modeOf({ check: false }, 'idle')).toBe('off');
    expect(modeOf({ check: true }, 'off')).toBe('ask');
  });
});
