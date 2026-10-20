import { describe, expect, it } from 'vitest';
import { FRESH_MS, fileKind, followed, foldersWithFiles, isFresh, scratchPlace, timeAgo } from '../packages/mac/src/layout/panel/scratch-model.js';

/** The Scratch tab's small decisions: how long ago, what a file is, which one to show. */
describe('Scratch tab model', () => {
  const now = 1_000_000_000;
  it('says how long ago, briefly', () => {
    expect(timeAgo(now - 500, now)).toBe('now');
    expect(timeAgo(now - 12_000, now)).toBe('12s');
    expect(timeAgo(now - 3 * 60_000, now)).toBe('3m');
    expect(timeAgo(now - 5 * 3_600_000, now)).toBe('5h');
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3d');
  });

  it('knows a picture, a PDF, JSON, Markdown and the rest', () => {
    expect(fileKind('.context/a.PNG')).toBe('image');
    expect(fileKind('.context/b.pdf')).toBe('pdf');
    expect(fileKind('.context/r.json')).toBe('json');
    expect(fileKind('.context/notes.md')).toBe('markdown');
    expect(fileKind('.context/log.txt')).toBe('text');
  });

  it('marks what was just written', () => {
    expect(isFresh(now - FRESH_MS + 1, now)).toBe(true);
    expect(isFresh(now - FRESH_MS - 1, now)).toBe(false);
  });

  it('follows the newest file, or keeps the one you picked while it’s there', () => {
    const files = [{ path: 'b', size: 1, mtime: 2 }, { path: 'a', size: 1, mtime: 1 }];
    expect(followed(files, true, 'a')).toBe('b');
    expect(followed(files, false, 'a')).toBe('a');
    expect(followed(files, false, 'gone')).toBe('b');
    expect(followed([], true, undefined)).toBeUndefined();
  });

  const roots = ['.klaud/scratch', '.context'];
  it('says which shown folder a file is in, the folders under it, and its name', () => {
    expect(scratchPlace('.klaud/scratch/shots/a.png', roots)).toEqual({ root: '.klaud/scratch', dir: 'shots', name: 'a.png' });
    expect(scratchPlace('.context/b.png', roots)).toEqual({ root: '.context', dir: '', name: 'b.png' });
    expect(scratchPlace('.context/x/y/c.md', roots)).toEqual({ root: '.context', dir: 'x/y', name: 'c.md' });
  });

  it('names only the folders that have files, in their order', () => {
    expect(foldersWithFiles([{ path: '.context/a', size: 1, mtime: 1 }], roots)).toEqual(['.context']);
    expect(foldersWithFiles([{ path: '.context/a', size: 1, mtime: 2 }, { path: '.klaud/scratch/b', size: 1, mtime: 1 }], roots)).toEqual(roots);
    expect(foldersWithFiles([], roots)).toEqual([]);
  });
});
