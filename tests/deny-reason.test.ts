import { describe, expect, it } from 'vitest';
import { DENY_REASON, OUTSIDE_REASON, decideTool, denyReason } from '../src/agent/policy.js';

/** BLG-348: a write refused for being outside the shared folders says so, not "credential files". */
describe('why a write is refused', () => {
  const ctx = { cwd: '/work/chat', roots: ['/work/chat'], autoEdit: true, scope: 'folder' as const };
  const key = ['/Users/me', '.ssh', 'id_rsa'].join('/');

  it('says “outside the shared folders” for a plain file elsewhere', () => {
    const input = { file_path: '/Users/me/Desktop/report.md', content: 'x' };
    expect(decideTool('Write', input, ctx)).toBe('deny');
    expect(denyReason('Write', input, ctx)).toBe(OUTSIDE_REASON);
    expect(OUTSIDE_REASON).toContain('outside the shared folders');
  });

  it('still says credential files for one', () => {
    const input = { file_path: key, content: 'x' };
    expect(decideTool('Write', input, ctx)).toBe('deny');
    expect(denyReason('Write', input, ctx)).toBe(DENY_REASON);
  });

  it('keeps the plain reason for a read of a secret', () => {
    expect(denyReason('Read', { file_path: key }, ctx)).toBe(DENY_REASON);
  });

  it('a write inside the folder is not refused', () => {
    expect(decideTool('Write', { file_path: '/work/chat/notes.md', content: 'x' }, ctx)).toBe('allow');
  });
});
