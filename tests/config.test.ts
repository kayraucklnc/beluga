import { describe, expect, it } from 'vitest';
import { parseConfig, sanitizeName } from '../src/config.js';
import { Settings } from '../src/core/settings.js';

describe('parseConfig', () => {
  it('defaults to hosting; help on request', () => {
    expect(parseConfig([], '/tmp/p', '/Users/x', Settings.parse({})).mode).toBe('host');
    expect(parseConfig(['host', '-h']).mode).toBe('help');
  });

  // Not on Windows: POSIX paths in the fixtures.
  it.skipIf(process.platform === 'win32')('parses host options', () => {
    const c = parseConfig(['host', '-n', 'kay!', '-s', 'web=./site:rw', '--tunnel', 'none', '--lan', '-p', '4000', '--policy', 'auto'], '/tmp');
    expect(c).toMatchObject({ mode: 'host', name: 'kay', tunnel: 'none', lan: true, port: 4000, policy: 'auto', agent: true });
    expect(c.shares).toEqual([{ name: 'web', root: '/tmp/site', writable: true }]);
    expect(c).toMatchObject({ policyChosen: true, mouse: true });
    expect(parseConfig(['host', '--no-mouse'], '/tmp/p')).toMatchObject({ policyChosen: false, mouse: false });
  });

  it('shares nothing and stays solo by default; supports --no-share/--no-agent/--invite', () => {
    expect(parseConfig(['host'], '/tmp/proj').shares).toEqual([]);
    expect(parseConfig(['host']).inviteNow).toBe(false);
    expect(parseConfig(['host', '--invite']).inviteNow).toBe(true);
    const c = parseConfig(['join', 'klaud:x', '--no-share', '--no-agent']);
    expect(c).toMatchObject({ mode: 'join', invite: 'klaud:x', shares: [], agent: false });
  });

  it('warns when you explicitly share your whole home folder or disk', () => {
    const home = parseConfig(['host', '-s', '.'], '/Users/kay', '/Users/kay');
    expect(home.shares).toHaveLength(1); // explicit is allowed
    expect(home.notes[0]).toMatch(/whole home folder/);
    expect(parseConfig(['host', '-s', '/'], '/Users/kay', '/Users/kay').notes).toHaveLength(1);
    expect(parseConfig(['host', '-s', '.'], '/Users/kay/proj', '/Users/kay').notes).toEqual([]);
  });

  it('validates input', () => {
    expect(() => parseConfig(['dance'])).toThrow(/Unknown command/);
    expect(parseConfig(['join']).invite).toBeUndefined(); // read from clipboard later
    expect(() => parseConfig(['host', '--tunnel', 'x'])).toThrow(/--tunnel/);
    expect(() => parseConfig(['host', '--policy', 'x'])).toThrow(/--policy/);
    expect(() => parseConfig(['host', '-p', '99999'])).toThrow(/--port/);
    expect(() => parseConfig(['host', '-s', 'a=/x', '-s', 'a=/y'])).toThrow(/Two shares/);
  });

  it('sanitizes names', () => {
    expect(sanitizeName('  ')).toBe('anon');
    expect(sanitizeName('a b/c')).toBe('abc');
  });
});
