import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderSize, formatBytes, measureAll } from '../src/workspaces/disk.js';

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe('formatBytes', () => {
  it.each([
    [0, '0 KB'],
    [-5000, '0 KB'],
    [512, '1 KB'],
    [100 * KB, '100 KB'],
    [MB - 1, '1024 KB'],
    [MB, '1 MB'],
    [340 * MB, '340 MB'],
    [GB, '1.0 GB'],
    [1.25 * GB, '1.3 GB'],
    [10 * GB - MB * 200, '9.8 GB'],
    [10 * GB, '10 GB'],
    [123.4 * GB, '123 GB'],
  ])('%d → %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('measureAll', () => {
  it('measures one at a time, in order, and skips undefined', async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const measure = async (p: string) => {
      calls.push(p);
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return p === '/b' ? undefined : p.length * 100;
    };
    const out = await measureAll(
      [
        { id: 'a', path: '/a' },
        { id: 'b', path: '/b' },
        { id: 'c', path: '/ccc' },
      ],
      measure,
    );
    expect(calls).toEqual(['/a', '/b', '/ccc']);
    expect(maxActive).toBe(1);
    expect(out).toEqual({ a: 200, c: 400 });
  });

  it('returns {} for no folders', async () => {
    expect(await measureAll([], async () => 1)).toEqual({});
  });

  it('keeps zero sizes', async () => {
    expect(await measureAll([{ id: 'z', path: '/z' }], async () => 0)).toEqual({ z: 0 });
  });
});

describe('folderSize', () => {
  it('measures a real folder in bytes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-disk-'));
    writeFileSync(path.join(dir, 'blob'), Buffer.alloc(64 * KB, 1));
    const size = await folderSize(dir);
    expect(size).toBeGreaterThan(0);
    expect(size! % 1024).toBe(0);
  });

  it('returns undefined for a missing folder', async () => {
    expect(await folderSize(path.join(os.tmpdir(), 'klaud-disk-missing-' + process.pid + '-' + Date.now()))).toBeUndefined();
  });
});
