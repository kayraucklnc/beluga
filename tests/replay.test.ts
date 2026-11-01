import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRESH_MS, ReplayGuard } from '../src/core/replay.js';

describe('ReplayGuard', () => {
  it('lets a fresh request in once, refuses repeats and stale ones', () => {
    let now = 1_000_000_000;
    const g = new ReplayGuard(undefined, FRESH_MS, () => now);
    expect(g.admit('a:1', now)).toBe(true);
    expect(g.admit('a:1', now)).toBe(false);
    expect(g.admit('a:2', now - FRESH_MS - 1)).toBe(false);
    expect(g.admit('a:3', now + FRESH_MS + 1)).toBe(false); // from the future (clock games)
    now += 1000;
    expect(g.admit('a:4', now - 5000)).toBe(true);
  });

  it('remembers across restarts, privately, and forgets what has expired', () => {
    let now = 2_000_000_000;
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-replay-')), 'seen.json');
    const first = new ReplayGuard(file, FRESH_MS, () => now);
    expect(first.admit('bob:iv1', now)).toBe(true);
    first.flush();
    // Windows has no Unix modes: the user profile's own ACL keeps it private there.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new ReplayGuard(file, FRESH_MS, () => now);
    expect(restarted.admit('bob:iv1', now)).toBe(false);
    now += FRESH_MS * 3;
    const later = new ReplayGuard(file, FRESH_MS, () => now);
    expect(later.admit('bob:iv1', now)).toBe(true);
  });

  it('starts empty when the file is missing or broken', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-replay-'));
    const missing = new ReplayGuard(path.join(dir, 'nope', 'seen.json'));
    expect(missing.admit('x', Date.now())).toBe(true);
    missing.flush();
    writeFileSync(path.join(dir, 'broken.json'), '{not json');
    expect(new ReplayGuard(path.join(dir, 'broken.json')).admit('x', Date.now())).toBe(true);
  });
});
