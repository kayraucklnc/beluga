import { describe, expect, it } from 'vitest';
import { ownerSettings } from '../src/agent/runner.js';

/** Your own runs load your Claude Code settings and skills; a project's .claude/ never loads (BLG-521). */
describe('ownerSettings', () => {
  it('loads your user settings and every skill in your own runs', () => {
    expect(ownerSettings({ ownerMcp: true })).toEqual({ settingSources: ['user'], skills: 'all' });
  });

  it('never loads project or local settings, which a friend with :rw access could write', () => {
    for (const input of [{ ownerMcp: true }, { ownerMcp: true, guest: true }, {}]) {
      expect(ownerSettings(input).settingSources).not.toContain('project');
      expect(ownerSettings(input).settingSources).not.toContain('local');
    }
  });

  it("loads nothing of yours in a friend's or a guest's run", () => {
    expect(ownerSettings({})).toEqual({ settingSources: [] });
    expect(ownerSettings({ ownerMcp: true, guest: true })).toEqual({ settingSources: [] });
  });
});
