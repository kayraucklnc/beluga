import { describe, expect, it } from 'vitest';
import { parseConfig, sanitizeName } from '../src/config.js';

describe('parseConfig', () => {
  it('defaults to help', () => {
    expect(parseConfig([]).mode).toBe('help');
    expect(parseConfig(['host', '-h']).mode).toBe('help');
  });

  it('parses host options', () => {
    const c = parseConfig(['host', '-n', 'kay!', '-s', 'web=./site:rw', '--tunnel', 'none', '--lan', '-p', '4000', '--policy', 'auto'], '/tmp');
    expect(c).toMatchObject({ mode: 'host', name: 'kay', tunnel: 'none', lan: true, port: 4000, policy: 'auto', agent: true });
    expect(c.shares).toEqual([{ name: 'web', root: '/tmp/site', writable: true }]);
  });

  it('shares cwd read-only by default and supports --no-share/--no-agent', () => {
    expect(parseConfig(['host'], '/tmp/proj').shares).toEqual([{ name: 'proj', root: '/tmp/proj', writable: false }]);
    const c = parseConfig(['join', 'klaude:x', '--no-share', '--no-agent']);
    expect(c).toMatchObject({ mode: 'join', invite: 'klaude:x', shares: [], agent: false });
  });

  it('validates input', () => {
    expect(() => parseConfig(['dance'])).toThrow(/Unknown command/);
    expect(() => parseConfig(['join'])).toThrow(/Usage/);
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
