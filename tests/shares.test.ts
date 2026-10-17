import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ShareService, isDenied, parseShareSpec, resolveInShare } from '../src/core/shares.js';
import { waitFor } from './helpers.js';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-share-')));
const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-out-')));
mkdirSync(path.join(root, 'src'));
writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(path.join(root, 'README.md'), '# hi');
writeFileSync(path.join(root, '.env'), 'SECRET=1');
writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
writeFileSync(path.join(outside, 'secret.txt'), 'nope');
symlinkSync(outside, path.join(root, 'escape'));

const share = { name: 'proj', root, writable: false };
const svc = new ShareService([share]);

afterAll(() => svc.close());

describe('parseShareSpec', () => {
  it('parses name, path and rw flag', () => {
    expect(parseShareSpec('web=./site:rw', '/tmp')).toEqual({ name: 'web', root: '/tmp/site', writable: true });
    expect(parseShareSpec('/a/b:ro', '/tmp')).toEqual({ name: 'b', root: '/a/b', writable: false });
    expect(parseShareSpec('.', '/tmp/my proj')).toEqual({ name: 'my_proj', root: '/tmp/my proj', writable: false });
  });
});

describe('isDenied', () => {
  it('blocks secrets and heavy folders', () => {
    for (const p of ['.env', 'a/.env.local', '.git/config', 'node_modules/x', 'k.pem', '.ssh/id_rsa', 'id_ed25519']) {
      expect(isDenied(p)).toBe(true);
    }
    expect(isDenied('src/env.ts')).toBe(false);
  });
});

describe('resolveInShare', () => {
  it('resolves normal paths', () => {
    expect(resolveInShare(share, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveInShare(share, '/README.md')).toBe(path.join(root, 'README.md'));
  });

  it('blocks traversal, private files and symlink escapes', () => {
    expect(() => resolveInShare(share, '../etc/passwd')).toThrow(/traversal/);
    expect(() => resolveInShare(share, 'src/../../x')).toThrow(/traversal/);
    expect(() => resolveInShare(share, '.env')).toThrow(/private/);
    expect(() => resolveInShare(share, 'escape/secret.txt')).toThrow(/Symlink/);
  });
});

describe('ShareService', () => {
  it('lists directories (dirs first, private files and escaping links hidden)', async () => {
    const entries = await svc.list('proj', '');
    expect(entries.map((e) => e.name)).toEqual(['src', 'bin.dat', 'README.md']);
    expect(entries.find((e) => e.name === 'README.md')?.size).toBe(4);
  });

  it('reads text and flags binary', async () => {
    expect(await svc.read('proj', 'src/a.ts')).toEqual({ content: 'export const a = 1;\n', truncated: false });
    expect((await svc.read('proj', 'bin.dat')).content).toBe('[binary file]');
    await expect(svc.read('proj', 'src')).rejects.toThrow(/directory/);
    await expect(svc.read('nope', 'x')).rejects.toThrow(/No share/);
  });

  it('reads binary-safe chunks for downloads', async () => {
    const { data, total } = await svc.readChunk('proj', 'bin.dat', 1, 10);
    expect(total).toBe(3);
    expect([...data]).toEqual([0, 2]);
    await expect(svc.readChunk('proj', 'src', 0, 10)).rejects.toThrow(/folder/);
  });

  it('locates absolute paths inside shares', () => {
    expect(svc.locate(path.join(root, 'src', 'a.ts'))).toEqual({ share: 'proj', path: 'src/a.ts' });
    expect(svc.locate(path.join(outside, 'secret.txt'))).toBeUndefined();
    expect(svc.locate(path.join(root, '.env'))).toBeUndefined();
    expect(svc.infos).toEqual([{ name: 'proj', writable: false }]);
  });

  it('reports file changes', async () => {
    const seen: string[] = [];
    svc.watch((s, p) => seen.push(`${s}:${p}`));
    writeFileSync(path.join(root, 'src', 'b.ts'), 'v1');
    svc.watchFile('proj', 'src/b.ts'); // only files someone opened are watched
    svc.watchFile('proj', 'src/b.ts');
    svc.watchFile('proj', '../escape');
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path.join(root, 'src', 'b.ts'), 'v2');
    await waitFor(() => seen.includes('proj:src/b.ts'), 5000);
  });
});

describe('ShareService.watch errors', () => {
  it('reports watcher errors instead of crashing', async () => {
    const s = new ShareService([{ name: 'x', root, writable: false }]);
    const errors: string[] = [];
    s.watch(() => undefined, (m) => errors.push(m));
    const watcher = (s as unknown as { watcher: { emit: (e: string, err: Error) => void } }).watcher;
    watcher.emit('error', new Error('EMFILE: too many'));
    watcher.emit('error', new Error('EMFILE: again'));
    expect(errors).toEqual(['Live file updates paused: EMFILE: too many']);
    await s.close();
  });
});
