import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_PAGE, FilePageView, FolderView, FoundView } from '../src/companion/protocol.js';
import { RefTable } from '../src/companion/files.js';
import { findByName, gate, langOf, listFolder, readPage } from '../src/companion/worktree-files.js';

/** A worktree's files on the phone (BLG-42): read-only, inside the worktree, never a secret. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function worktree() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beluga-wt-files-')));
  dirs.push(base);
  const root = path.join(base, 'wt');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Landing\n');
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
  writeFileSync(path.join(root, 'src', 'core', 'store.ts'), 'const token = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";\nexport {};\n');
  writeFileSync(path.join(root, '.env'), 'STRIPE_KEY=sk_live_123\n');
  writeFileSync(path.join(root, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\n');
  writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
  writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(path.join(outside, 'notes.txt'), 'private notes outside the worktree\n');
  writeFileSync(path.join(outside, 'secret.key'), 'nope\n');
  // Links: one that stays inside, one that leads out, one to a secret inside.
  symlinkSync(path.join(root, 'src', 'index.ts'), path.join(root, 'inside-link.ts'));
  symlinkSync(path.join(outside, 'notes.txt'), path.join(root, 'escape.txt'));
  symlinkSync(outside, path.join(root, 'escape-dir'));
  symlinkSync(path.join(root, '.env'), path.join(root, 'config.txt'));
  return { root, outside };
}

describe('the companion’s file gate', () => {
  it('lists a folder: folders first, no .git, no secrets, no links that lead out or to a secret', async () => {
    const { root } = worktree();
    const top = FolderView.parse(await listFolder(root, '', new RefTable(() => 'abcdefghijkl')));
    expect(top.path).toBe('');
    expect(top.entries.map((e) => e.name)).toEqual(['node_modules', 'src', 'inside-link.ts', 'logo.png', 'README.md']);
    expect(top.entries.find((e) => e.name === 'src')).toMatchObject({ dir: true });
    expect(top.entries.find((e) => e.name === 'README.md')).toMatchObject({ dir: false, size: 10 });
    // A picture can open in the image viewer, by ref (never a path).
    expect(top.entries.find((e) => e.name === 'logo.png')?.ref).toBe('out:abcdefghijkl');
    const src = await listFolder(root, 'src');
    expect(src.entries.map((e) => e.name)).toEqual(['core', 'index.ts']);
    expect(JSON.stringify(top)).not.toContain(root);
  });

  it('refuses paths outside the worktree, into .git, and secrets', async () => {
    const { root, outside } = worktree();
    await expect(listFolder(root, '..')).rejects.toThrow(/inside the worktree/);
    await expect(readPage(root, '../outside/notes.txt')).rejects.toThrow(/inside the worktree/);
    await expect(readPage(root, path.join(outside, 'notes.txt'))).rejects.toThrow(/inside the worktree/);
    await expect(readPage(root, 'src/../../outside/notes.txt')).rejects.toThrow(/inside the worktree/);
    await expect(readPage(root, '.git/config')).rejects.toThrow(/Git/);
    await expect(listFolder(root, '.git')).rejects.toThrow(/Git/);
    await expect(readPage(root, '.env')).rejects.toThrow(/secret/);
    await expect(readPage(root, 'id_rsa')).rejects.toThrow(/secret/);
    await expect(readPage(root, 'missing.ts')).rejects.toThrow(/isn’t there/);
  });

  it('follows links and checks where they really lead', async () => {
    const { root } = worktree();
    // Inside: fine. Out of the worktree, or onto a secret under another name: refused.
    expect((await readPage(root, 'inside-link.ts')).text).toBe('export const answer = 42;\n');
    await expect(readPage(root, 'escape.txt')).rejects.toThrow(/outside the worktree/);
    await expect(listFolder(root, 'escape-dir')).rejects.toThrow(/outside the worktree/);
    await expect(readPage(root, 'escape-dir/notes.txt')).rejects.toThrow(/outside the worktree/);
    await expect(readPage(root, 'config.txt')).rejects.toThrow(/secret/);
    expect(() => gate(root, 'escape.txt')).toThrow(/outside/);
  });

  it('reads source read-only, in pages, with secrets in it redacted and its language for colours', async () => {
    const { root } = worktree();
    const page = FilePageView.parse(await readPage(root, 'src/core/store.ts'));
    expect(page).toMatchObject({ path: 'src/core/store.ts', off: 0, eof: true, lang: 'ts' });
    expect(page.text).not.toContain('sk-ant-api03');
    expect(page.text).toContain('export {};');
    // A big file comes in pages of whole lines, each a frame's worth at most.
    const line = `${'x'.repeat(99)}\n`;
    writeFileSync(path.join(root, 'big.log'), line.repeat(Math.ceil((FILE_PAGE * 1.5) / 100)));
    const first = await readPage(root, 'big.log');
    expect(first.eof).toBe(false);
    expect(first.text.length).toBeLessThanOrEqual(FILE_PAGE);
    expect(first.text.endsWith('\n')).toBe(true);
    const second = await readPage(root, 'big.log', first.next);
    expect(second.off).toBe(first.next);
    expect(second.eof).toBe(true);
    expect(first.text.length + second.text.length).toBe(first.size);
    // Not text: nothing is sent.
    expect(await readPage(root, 'logo.png')).toMatchObject({ binary: true, text: '' });
    expect(langOf('Dockerfile')).toBe('docker');
    expect(langOf('a.py')).toBe('py');
    expect(langOf('a.unknown')).toBeUndefined();
  });

  it('finds files by name across the worktree, never secrets, .git or what links lead out to', async () => {
    const { root } = worktree();
    const found = FoundView.parse(await findByName(root, 'store'));
    expect(found.hits).toEqual([{ path: 'src/core/store.ts', dir: false }]);
    expect((await findByName(root, 'env')).hits).toEqual([]);
    expect((await findByName(root, 'config')).hits).toEqual([]);
    expect((await findByName(root, 'notes')).hits).toEqual([]);
    expect((await findByName(root, 'index')).hits.map((h) => h.path)).toEqual(['src/index.ts']);
  });
});
