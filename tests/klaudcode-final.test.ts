import { describe, expect, it } from 'vitest';
import { MOVE_NOTE, movePackageNote } from '../src/core/rename-note.js';

/** The last klaudcode on npm tells its users how to move to beluga-code (KLD-89). */

describe('an install under the old npm name', () => {
  it('says how to move on every start', () => {
    expect(movePackageNote('klaudcode')).toBe(MOVE_NOTE);
    expect(movePackageNote('klaudcode')).toBe(MOVE_NOTE);
  });

  it("removes klaudcode before installing beluga-code (npm won't install over its `klaud` command)", () => {
    expect(MOVE_NOTE).toContain('klaud update');
    expect(MOVE_NOTE).toMatch(/npm uninstall -g klaudcode && npm i -g beluga-code/);
  });

  it('says nothing for beluga-code', () => {
    expect(movePackageNote('beluga-code')).toBeUndefined();
  });
});
