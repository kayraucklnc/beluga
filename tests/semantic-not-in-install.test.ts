import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Semantic tool search is fetched only when a person turns it on (src/external/adapters/semantic-fetch.ts).
 * With it off, the install and the built daemon hold no @ratel-ai package, and the lockfile keeps main's
 * Linux libc marks: a lockfile rewritten by another npm once grew the Linux sidecar from 693 MB to 961 MB.
 */

const root = path.resolve(import.meta.dirname, '..');
const RATEL = /@ratel-ai\//;
/** An import of a package by name: what npm would have to install. A file path (the fetched copy) is not one. */
const IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@ratel-ai\//;

describe('semantic tool search is not in the install', () => {
  it('package.json names no @ratel-ai package', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    expect(names.filter((n) => RATEL.test(n))).toEqual([]);
  });

  it('the lockfile installs no @ratel-ai package, and keeps libc on every Linux gnu and musl build', () => {
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { os?: string[]; libc?: string[] }> };
    expect(Object.keys(lock.packages).filter((k) => RATEL.test(k))).toEqual([]);
    const linux = Object.entries(lock.packages).filter(([name, p]) => p.os?.includes('linux') && /-(gnu|musl)$/.test(name));
    expect(linux.length).toBeGreaterThan(10);
    expect(linux.filter(([, p]) => !p.libc).map(([name]) => name)).toEqual([]);
  });

  it('the built daemon imports no @ratel-ai package', () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'built-daemon-'));
    try {
      execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.build.json'), '--outDir', out], { cwd: root, stdio: 'pipe' });
      const files = (readdirSync(out, { recursive: true }) as string[]).filter((f) => f.endsWith('.js'));
      expect(files).toContain(path.join('external', 'adapters', 'semantic-fetch.js'));
      expect(files.filter((f) => IMPORT.test(readFileSync(path.join(out, f), 'utf8')))).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
