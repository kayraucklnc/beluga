import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeBinary, claudeCodePin, installClaudeCode } from '../src/agent/claude-code.js';

/** A tarball shaped like npm's platform package (package/claude, package/claude.exe on Windows), and its npm integrity. */
function fakePackage(dir: string, body: string): { tgz: string; integrity: string } {
  const src = path.join(dir, 'src');
  mkdirSync(path.join(src, 'package'), { recursive: true });
  writeFileSync(path.join(src, 'package', process.platform === 'win32' ? 'claude.exe' : 'claude'), body);
  writeFileSync(path.join(src, 'package', 'README.md'), 'readme');
  const tgz = path.join(dir, `pkg-${body.length}.tgz`);
  execFileSync('tar', ['-czf', tgz, '-C', src, 'package']);
  return { tgz, integrity: `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}` };
}

const copyAsDownload = (tgz: string) => async (_url: string, to: string, onBytes: (got: number, total?: number) => void) => {
  copyFileSync(tgz, to);
  onBytes(statSync(to).size, statSync(to).size);
};

describe('Claude Code, downloaded on first launch (BLG-384)', () => {
  it('reads the pin the build wrote, and ignores one without a sha512 integrity', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-pin-'));
    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ version: '0.3.301', url: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-abc' }));
    expect(claudeCodePin(good)).toEqual({ version: '0.3.301', url: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-abc' });
    const weak = path.join(dir, 'weak.json');
    writeFileSync(weak, JSON.stringify({ version: '1', url: 'u', integrity: 'sha1-abc' }));
    expect(claudeCodePin(weak)).toBeUndefined();
    expect(claudeCodePin(path.join(dir, 'missing.json'))).toBeUndefined();
  });

  it('unpacks the checked binary into its version folder, executable, and removes older versions', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
    const work = mkdtempSync(path.join(os.tmpdir(), 'cc-work-'));
    mkdirSync(path.join(home, 'claude-code', '0.3.200'), { recursive: true });
    const { tgz, integrity } = fakePackage(work, '#!/bin/sh\necho claude\n');
    const pin = { version: '0.3.301', url: 'https://example.invalid/pkg.tgz', integrity };
    const seen: number[] = [];
    const bin = await installClaudeCode(pin, { home, download: copyAsDownload(tgz), onProgress: (p) => seen.push(p.got) });
    expect(bin).toBe(claudeCodeBinary(pin, home));
    expect(readFileSync(bin, 'utf8')).toContain('echo claude');
    // Windows runs any .exe: no executable bit to check.
    if (process.platform !== 'win32') expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(existsSync(path.join(path.dirname(bin), 'README.md'))).toBe(false);
    expect(existsSync(path.join(home, 'claude-code', '0.3.200'))).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('refuses a download that doesn’t match the pinned integrity, and leaves nothing behind', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
    const work = mkdtempSync(path.join(os.tmpdir(), 'cc-work-'));
    const { tgz } = fakePackage(work, 'tampered');
    const { integrity } = fakePackage(work, 'the real one');
    const pin = { version: '0.3.301', url: 'https://example.invalid/pkg.tgz', integrity };
    await expect(installClaudeCode(pin, { home, download: copyAsDownload(tgz) })).rejects.toThrow(/didn’t match/);
    expect(existsSync(claudeCodeBinary(pin, home))).toBe(false);
    expect(existsSync(path.join(home, 'claude-code', '0.3.301.tgz.part'))).toBe(false);
  });
});
