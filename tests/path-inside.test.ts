import { describe, expect, it } from 'vitest';
import { isUnder, underPart } from '../src/shared/path-inside.js';

describe('a path inside a folder, on every system', () => {
  it('is the folder or under it, never a look-alike sibling', () => {
    expect(isUnder('/code/app', '/code/app')).toBe(true);
    expect(isUnder('/code/app', '/code/app/src/a.ts')).toBe(true);
    expect(isUnder('/code/app', '/code/app-old/a.ts')).toBe(false);
    expect(isUnder('/', '/etc')).toBe(true);
    expect(isUnder('', '/x')).toBe(false);
  });

  it('takes Windows paths with either slash, in any letter case', () => {
    expect(isUnder('C:\\code\\app', 'C:\\code\\app\\src\\a.ts')).toBe(true);
    expect(isUnder('C:\\code\\app', 'c:\\Code\\App\\notes.md')).toBe(true);
    expect(isUnder('C:\\code\\app', 'C:\\code\\app/src/a.ts')).toBe(true);
    expect(isUnder('C:\\code\\app', 'C:\\code\\apple\\a.ts')).toBe(false);
    expect(underPart('C:\\code\\app', 'C:\\code\\app\\src\\a.ts')).toBe('src\\a.ts');
    expect(underPart('/code/app', '/code/app/src/a.ts')).toBe('src/a.ts');
    expect(underPart('/code/app', '/code/app')).toBeUndefined();
  });

  it("is exact about letter case on a Mac's and Linux's paths", () => {
    expect(isUnder('/code/app', '/Code/App/a.ts')).toBe(false);
  });
});
