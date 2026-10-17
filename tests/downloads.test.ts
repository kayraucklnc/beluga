import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Requester, downloadFile, safeFileName, uniquePath } from '../src/core/downloads.js';
import { Store, initialState } from '../src/core/store.js';

describe('download helpers', () => {
  it('sanitizes file names', () => {
    expect(safeFileName('a/b/../evil.sh')).toBe('evil.sh');
    expect(safeFileName('..\\..\\x')).toBe('x');
    expect(safeFileName('.bashrc')).toBe('_bashrc');
    expect(safeFileName('we!rd*name?.txt')).toBe('we_rd_name_.txt');
    expect(safeFileName('')).toBe('download');
  });

  it('never overwrites existing files', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-dl-'));
    writeFileSync(path.join(dir, 'a.txt'), '1');
    writeFileSync(path.join(dir, 'a (1).txt'), '2');
    expect(await uniquePath(dir, 'a.txt')).toBe(path.join(dir, 'a (2).txt'));
    expect(await uniquePath(dir, 'b.txt')).toBe(path.join(dir, 'b.txt'));
  });

  it('reassembles chunks and tracks progress', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-dl-'));
    const store = new Store(initialState('r'));
    const content = Buffer.from('hello world, in pieces');
    const request: Requester = async <T>(_to: string, body: object) => {
      const offset = 'offset' in body && typeof body.offset === 'number' ? body.offset : 0;
      const data = content.subarray(offset, offset + 5);
      return { kind: 'fs_chunk', reqId: 'x', ok: true, data: data.toString('base64'), offset, total: content.length } as T;
    };
    const saved = await downloadFile({ owner: 'b', share: 'api', path: 'docs/notes.txt' }, 'bob', request, store, dir);
    expect(saved).toBe(path.join(dir, 'bob', 'notes.txt'));
    expect(readFileSync(saved, 'utf8')).toBe('hello world, in pieces');
    expect(store.getState().transfers.at(-1)).toMatchObject({ status: 'done', received: content.length, savedTo: saved });
  });

  it('reports failures', async () => {
    const store = new Store(initialState('r'));
    const bad = async <T>() => ({ kind: 'fs_chunk', reqId: 'x', ok: true, data: '', offset: 99, total: 10 }) as T;
    await expect(downloadFile({ owner: 'b', share: 'api', path: 'x' }, 'bob', bad, store, os.tmpdir())).rejects.toThrow(/out of sync/);
    expect(store.getState().transfers.at(-1)).toMatchObject({ status: 'failed', error: 'Transfer got out of sync' });
    const huge = async <T>() => ({ kind: 'fs_chunk', reqId: 'x', ok: true, data: '', offset: 0, total: 1e12 }) as T;
    await expect(downloadFile({ owner: 'b', share: 'api', path: 'x' }, 'bob', huge, store, os.tmpdir())).rejects.toThrow(/too large/);
  });
});
