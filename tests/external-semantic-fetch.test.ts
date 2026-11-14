import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { addonFor, checkSemantic, fetchSemantic, type ModelFile, type Pin, removeSemantic, SEMANTIC_VERSION, semanticDir } from '../src/external/adapters/semantic-fetch.js';
import { semanticSearch } from '../src/external/adapters/semantic-search.js';
import type { ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { withDiscovery } from '../src/external/adapters/tools/discover.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A real npm-style tarball (package/…) and its pin, as the registry gives it. */
function tarball(root: string, name: string, files: Record<string, string> = { 'index.js': 'export const ok = 1;\n' }): { file: string; pin: Pin } {
  const src = path.join(root, `src-${name.replace(/\W/g, '_')}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, 'package', rel)), { recursive: true });
    writeFileSync(path.join(src, 'package', rel), text);
  }
  const file = path.join(root, `${name.replace(/\W/g, '_')}.tgz`);
  execFileSync('tar', ['-czf', file, '-C', src, 'package']);
  const bytes = readFileSync(file);
  return { file, pin: { name, version: '1.0.0', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, size: bytes.length } };
}

/** A model file and its pin. */
function modelFile(root: string, rel: string, text: string): { file: string; pin: ModelFile } {
  const file = path.join(root, `model-${rel.replace(/\W/g, '_')}`);
  writeFileSync(file, text);
  return { file, pin: { path: rel, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') } };
}

/** Serves each URL from a local file: npm tarballs by package name, model files by their path. */
function server(map: Record<string, string>) {
  return vi.fn(async (url: string, to: string) => {
    const hit = Object.entries(map).find(([end]) => url.endsWith(end));
    if (!hit) throw new Error(`no ${url}`);
    copyFileSync(hit[1], to);
  });
}

function fixture() {
  dir = mkdtempSync(path.join(os.tmpdir(), 'semantic-fetch-'));
  const pkg = tarball(dir, '@x/pkg');
  const model = modelFile(dir, '1_Pooling/config.json', '{"pooling_mode_cls_token":true}');
  const fetchTo = server({ 'pkg-1.0.0.tgz': pkg.file, '1_Pooling/config.json': model.file });
  return { pkg, model, fetchTo, opts: { home: dir, pins: [pkg.pin], model: { name: 'tiny', url: (rel: string) => `https://models.test/${rel}`, files: [model.pin] }, fetchTo } };
}

describe('fetching semantic tool search', () => {
  it('unpacks each pinned package by name after checking its sha512, and each model file after its sha256, once', async () => {
    const f = fixture();
    const progress: number[] = [];
    const root = await fetchSemantic({ ...f.opts, onProgress: (p) => progress.push(p.done) });
    expect(root).toBe(path.join(semanticDir(dir), SEMANTIC_VERSION));
    expect(readFileSync(path.join(root, 'node_modules', '@x', 'pkg', 'index.js'), 'utf8')).toContain('ok');
    expect(readFileSync(path.join(semanticDir(dir), 'models', 'tiny', '1_Pooling', 'config.json'), 'utf8')).toContain('cls');
    expect(f.fetchTo).toHaveBeenCalledWith('https://registry.npmjs.org/@x/pkg/-/pkg-1.0.0.tgz', expect.any(String), f.pkg.pin.size, expect.any(Function));
    expect(progress.at(-1)).toBe(f.pkg.pin.size + f.model.pin.size);
    await fetchSemantic(f.opts);
    expect(f.fetchTo).toHaveBeenCalledTimes(2);
  });

  it('refuses a package that does not match its sha512, and leaves nothing half-made', async () => {
    const f = fixture();
    await expect(fetchSemantic({ ...f.opts, pins: [{ ...f.pkg.pin, integrity: 'sha512-wrong' }] })).rejects.toThrow(/@x\/pkg.*did not match/);
    expect(existsSync(path.join(semanticDir(dir), SEMANTIC_VERSION))).toBe(false);
    expect(existsSync(path.join(semanticDir(dir), `${SEMANTIC_VERSION}.part`))).toBe(false);
  });

  it('refuses a model file that does not match its sha256', async () => {
    const f = fixture();
    await expect(fetchSemantic({ ...f.opts, model: { ...f.opts.model, files: [{ ...f.model.pin, sha256: '0'.repeat(64) }] } })).rejects.toThrow(/1_Pooling\/config.json.*did not match/);
    expect(existsSync(path.join(semanticDir(dir), 'models', 'tiny'))).toBe(false);
  });

  it('runs no install script: it unpacks, and never runs npm or the package', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'semantic-fetch-'));
    const marker = path.join(dir, 'a-script-ran');
    const run = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    const pkg = tarball(dir, 'scripted', {
      'package.json': JSON.stringify({ name: 'scripted', version: '1.0.0', scripts: { preinstall: `node -e "${run}"`, install: `node -e "${run}"`, postinstall: `node -e "${run}"`, prepare: `node -e "${run}"` } }),
      'install.js': run,
      'binding.gyp': '{}',
    });
    const root = await fetchSemantic({ home: dir, pins: [pkg.pin], model: { name: 'none', url: () => '', files: [] }, fetchTo: server({ 'scripted-1.0.0.tgz': pkg.file }) });
    expect(existsSync(path.join(root, 'node_modules', 'scripted', 'package.json'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses to load what changed on disk after the fetch', async () => {
    const f = fixture();
    const root = await fetchSemantic(f.opts);
    await expect(checkSemantic(root, f.opts)).resolves.toBeUndefined();
    appendFileSync(path.join(root, 'node_modules', '@x', 'pkg', 'index.js'), 'globalThis.pwned = 1;\n');
    await expect(checkSemantic(root, f.opts)).rejects.toThrow(/changed on disk/);
  });

  it('refuses a download bigger than its pin, before it ends', async () => {
    const f = fixture();
    await expect(fetchSemantic({ ...f.opts, pins: [{ ...f.pkg.pin, size: 10 }] })).rejects.toThrow(/bigger than/);
  });

  it('Turn off removes the packages, the model and the embedding file', async () => {
    const f = fixture();
    await fetchSemantic(f.opts);
    writeFileSync(path.join(semanticDir(dir), 'tools-abc.rat1'), 'x');
    await removeSemantic(dir);
    expect(existsSync(semanticDir(dir))).toBe(false);
  });

  it('picks the addon for this computer, and none where Ratel has no build', () => {
    expect(addonFor('darwin', 'arm64')?.name).toBe('@ratel-ai/sdk-darwin-arm64');
    expect(addonFor('linux', 'x64', true)?.name).toBe('@ratel-ai/sdk-linux-x64-gnu');
    expect(addonFor('linux', 'x64', false)).toBeUndefined();
    expect(addonFor('win32', 'arm64')).toBeUndefined();
  });
});

describe('a failed or tampered fetch leaves BM25 in use', () => {
  const def = (name: ExternalToolDef['name'], description: string): ExternalToolDef => ({ name, description, inputSchema: { id: z.string().optional() }, resolve: () => ({ target: '', inScope: true }), run: () => ({}) });
  const others = [def('sentinel_remove', 'Delete a sentinel.'), def('task_note', 'Leave a note on a task.')];
  const grant = { id: 'g', name: 'n', clientId: 'c', redirectHost: 'h', route: 'local', level: 'full', projects: 'all', chats: { dms: false, groups: false }, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0 } as const;

  it('a wrong sha512 refuses to load, says so once, and beluga_find keeps ranking with BM25', async () => {
    const f = fixture();
    const toasts: Array<[string, string]> = [];
    const load = vi.fn();
    const search = semanticSearch({
      tools: () => [],
      on: () => true,
      toast: (text, level) => void toasts.push([level, text]),
      open: async () => {
        await fetchSemantic({ ...f.opts, pins: [{ ...f.pkg.pin, integrity: 'sha512-tampered' }] });
        load();
        return { rank: async () => ['task_note', 'sentinel_remove'] };
      },
    });
    search.follow();
    await vi.waitFor(() => expect(search.status().state).toBe('failed'), { timeout: 15_000 });
    expect(search.status()).toMatchObject({ state: 'failed', error: expect.stringMatching(/did not match/) });
    expect(load).not.toHaveBeenCalled();
    const warnings = () => toasts.filter(([level]) => level === 'warn');
    expect(warnings()).toEqual([['warn', expect.stringMatching(/Semantic tool search could not get ready.*did not match.*built-in search/)]]);
    const find = withDiscovery([], others, search.rank).find((t) => t.name === 'beluga_find')!;
    const hits = (await find.run({ query: 'leave a note' }, grant as never)) as { tools: Array<{ name: string }> };
    expect(hits.tools.map((t) => t.name)).toEqual(['task_note']);
    search.follow();
    await flush();
    expect(warnings()).toHaveLength(1);
  });
});
