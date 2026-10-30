import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findCodex } from '../src/agent/runtime/codex/app-server.js';
import { CODEX_TRUST_TABLE, PROFILE, codexConfinement, originOf, trustRow, trustTableMarkdown } from '../src/agent/runtime/codex/sandbox.js';

/** A JSON value as TOML (inline tables), for `codex -c key=value`. */
function toml(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')}}`;
}

/** `sh -c script` in `cwd` under Codex's own sandbox, with the run's permissions profile. */
function inCodexSandbox(bin: string, config: Record<string, unknown>, cwd: string, script: string): string {
  const flags = ['default_permissions', `permissions.${PROFILE}`].flatMap((k) => ['-c', `${k}=${toml(config[k])}`]);
  const r = spawnSync(bin, ['sandbox', ...flags, '--', 'sh', '-c', script], { cwd, encoding: 'utf8', timeout: 30_000 });
  return `${r.stdout}${r.stderr}`;
}

describe('the Codex trust table', () => {
  it('says whose run it is', () => {
    expect(originOf({ viaAgent: false })).toBe('own');
    expect(originOf({ viaAgent: true })).toBe('friend');
    expect(originOf({ viaAgent: false, vetTool: () => undefined })).toBe('friend');
    expect(originOf({ guest: true, viaAgent: true })).toBe('guest');
  });

  it('picks a row per origin and reach', () => {
    expect(trustRow('own', 'folder')).toMatchObject({ approval: 'on-request', network: true, yourTools: true });
    expect(trustRow('friend', 'folder')).toMatchObject({ home: 'denied', network: false, approval: 'never', yourTools: false });
    expect(trustRow('friend', 'full')).toMatchObject({ home: 'read', network: false, approval: 'never' });
    expect(trustRow('guest', 'full').sandbox).toBe('refused');
  });

  it('is the table docs/security.md shows', () => {
    const doc = readFileSync(path.resolve(__dirname, '../docs/security.md'), 'utf8');
    const table = /<!-- codex-trust-table -->\n([\s\S]*?)\n<!-- \/codex-trust-table -->/.exec(doc)?.[1];
    expect(table).toBe(trustTableMarkdown());
    expect(CODEX_TRUST_TABLE.length).toBe(table!.split('\n').length - 2);
  });

  it('a main folder is read only, a fix-up worktree in it still writable', () => {
    const c = codexConfinement('own', 'full', { cwd: '/p/main', folders: ['/p/fix'], writable: ['/p/fix'], home: '/h', belugaHome: '/h/.beluga' });
    const profile = c.config[`permissions.${PROFILE}`] as { extends: string; filesystem: Record<string, string> };
    expect(profile.extends).toBe(':read-only');
    expect(profile.filesystem).toMatchObject({ '/p/main': 'read', '/p/fix': 'write', '/h/.beluga': 'deny', '/h/.ssh': 'deny', '/p/main/**/.env*': 'deny' });
  });
});

const found = findCodex();
// Installed and actually runs (an npm install whose native binary is missing is a shim that can't start).
const codex = found && spawnSync(found, ['--version'], { timeout: 15_000 }).status === 0 ? found : undefined;
describe.skipIf(!codex || process.platform !== 'darwin')("Codex's own sandbox, as Beluga sets it (the real codex binary)", () => {
  // Inside your home, so a friend reaching only shared folders is kept out of what's beside it.
  const dir = codex ? realpathSync(mkdtempSync(path.join(os.homedir(), 'Library', 'Caches', 'beluga-codex-sandbox-'))) : '';
  const work = path.join(dir, 'work');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  if (codex) {
    mkdirSync(path.join(work, 'sub'), { recursive: true });
    writeFileSync(path.join(work, '.env'), 'API_TOKEN=nope');
    writeFileSync(path.join(work, 'sub', '.env.local'), 'API_TOKEN=nope');
    writeFileSync(path.join(work, 'notes.txt'), 'hello');
    writeFileSync(path.join(dir, 'beside.txt'), 'x');
  }
  const script = 'cat notes.txt; echo; cat .env 2>&1 | head -1; cat sub/.env.local 2>&1 | head -1; echo made > made.txt && echo wrote; cat ../beside.txt >/dev/null 2>&1 && echo read-beside || echo beside-denied';

  it.each([
    ['ask me each time / trusted', 'folder'],
    ['full trust', 'full'],
  ] as const)("a friend's task (%s) can't read .env, and works in its folder", (_label, scope) => {
    const c = codexConfinement('friend', scope, { cwd: work, folders: [], writable: [work] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toContain('hello');
    expect(out).toMatch(/\.env: Operation not permitted/);
    expect(out).toMatch(/\.env\.local: Operation not permitted/);
    expect(out).not.toContain('API_TOKEN');
    expect(out).toContain('wrote');
    expect(out).toContain(scope === 'folder' ? 'beside-denied' : 'read-beside');
  });

  it("your own run can't read .env without asking either", () => {
    const c = codexConfinement('own', 'full', { cwd: work, folders: [], writable: [work] });
    const out = inCodexSandbox(codex!, c.config, work, script);
    expect(out).toMatch(/\.env: Operation not permitted/);
    expect(out).not.toContain('API_TOKEN');
    expect(out).toContain('read-beside');
  });
});
