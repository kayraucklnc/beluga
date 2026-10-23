import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidatePaths, imagePathsIn, pathsInPaste, pickPaths } from '../packages/mac/src/chat/paste-paths-model.js';
import { pathInfo } from '../src/core/attachments.js';

describe('a pasted file path', () => {
  const shot = '/Users/kayra/Library/Application Support/CleanShot/media/CleanShot 2026-10-21 at 22.11.43@2x.png';

  it('is found quoted, escaped, plain, as ~/ or a file:// URL', () => {
    expect(pathsInPaste(`"${shot}"`)).toEqual([shot]);
    expect(pathsInPaste(`'${shot}'`)).toEqual([shot]);
    expect(pathsInPaste(shot.replace(/ /g, '\\ '))).toEqual([shot]);
    expect(pathsInPaste(`  ${shot}\n`)).toEqual([shot]);
    expect(pathsInPaste('~/Desktop/a b.png')).toEqual(['~/Desktop/a b.png']);
    expect(pathsInPaste('file:///Users/kayra/My%20Shot.png')).toEqual(['/Users/kayra/My Shot.png']);
  });

  it('takes several, one per line or quoted side by side', () => {
    expect(pathsInPaste('/a/one.png\n/b/two file.pdf')).toEqual(['/a/one.png', '/b/two file.pdf']);
    expect(pathsInPaste("'/a/one.png' '/b/two.png'")).toEqual(['/a/one.png', '/b/two.png']);
    expect(pathsInPaste(`“${shot}”`)).toEqual([shot]);
  });

  it('leaves anything more than paths alone', () => {
    expect(pathsInPaste(`look at "${shot}"`)).toBeUndefined();
    expect(pathsInPaste(`${shot}\nand this`)).toBeUndefined();
    expect(pathsInPaste('/help')).toBeUndefined();
    expect(pathsInPaste('/compact keep the plan')).toBeUndefined();
    expect(pathsInPaste('https://example.com/a/b.png')).toBeUndefined();
    expect(pathsInPaste('')).toBeUndefined();
    expect(pathsInPaste('relative/path.png')).toBeUndefined();
  });
});

describe('an image path inside other text', () => {
  const shot = '/Users/kayra/Library/Application Support/CleanShot/media/CleanShot 2026-10-21 at 00.08.43@2x.png';
  /** What the text becomes when every reading in `files` is an image here (each path → [image]). */
  const swap = (text: string, files: readonly string[]): string => {
    let out = text;
    for (const p of pickPaths(imagePathsIn(text), (path) => files.includes(path)).reverse()) out = `${out.slice(0, p.start)}[image]${out.slice(p.end)}`;
    return out;
  };

  it('is found plain, with spaces, in a sentence', () => {
    expect(swap(`the button is off here ${shot} can you fix it`, [shot])).toBe('the button is off here [image] can you fix it');
    expect(swap(`${shot}, see?`, [shot])).toBe('[image], see?');
    expect(swap(`look (${shot}).`, [shot])).toBe('look ([image]).');
  });

  it('is found "quoted", ‘quoted’ and “smart quoted”, quotes and all', () => {
    expect(swap(`see "${shot}" please`, [shot])).toBe('see [image] please');
    expect(swap(`see '${shot}' please`, [shot])).toBe('see [image] please');
    expect(swap(`see “${shot}” please`, [shot])).toBe('see [image] please');
    expect(swap(`see ‘${shot}’ please`, [shot])).toBe('see [image] please');
  });

  it('is found with escaped spaces, as ~/ or a file:// URL', () => {
    expect(swap(`see ${shot.replace(/ /g, '\\ ')} now`, [shot])).toBe('see [image] now');
    expect(swap('see ~/Desktop/a b.png now', ['~/Desktop/a b.png'])).toBe('see [image] now');
    expect(swap('see file:///Users/kayra/My%20Shot.png now', ['/Users/kayra/My Shot.png'])).toBe('see [image] now');
  });

  it('tells two apart on one line, and finds them on several', () => {
    const text = 'before /a/one shot.png and /b/two.png after';
    expect(candidatePaths(imagePathsIn(text))).toEqual(expect.arrayContaining(['/a/one shot.png', '/a/one shot.png and /b/two.png', '/b/two.png']));
    expect(swap(text, ['/a/one shot.png', '/b/two.png'])).toBe('before [image] and [image] after');
    expect(swap('first /a/one.png\nthen “/b/two.png”', ['/a/one.png', '/b/two.png'])).toBe('first [image]\nthen [image]');
  });

  it('leaves words, other files, missing files and links alone', () => {
    expect(imagePathsIn('nothing to see here')).toEqual([]);
    expect(imagePathsIn('read /Users/kayra/notes.md first')).toEqual([]);
    expect(imagePathsIn('see https://example.com/a/b.png')).toEqual([]);
    expect(imagePathsIn('see relative/path.png')).toEqual([]);
    expect(imagePathsIn('/help me with x.png')).toEqual([]);
    expect(imagePathsIn('a /a/b.png.bak file')).toEqual([]);
    expect(swap(`see ${shot} now`, [])).toBe(`see ${shot} now`);
  });
});

describe('what a pasted path is here', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-paste-'));
  const png = path.join(dir, 'Shot 1.png');
  writeFileSync(png, 'x');
  mkdirSync(path.join(dir, 'folder'));

  it('tells files, folders and nothing apart', () => {
    expect(pathInfo(png)).toMatchObject({ path: png, name: 'Shot 1.png', kind: 'file', size: 1, image: true });
    expect(pathInfo(path.join(dir, 'folder')).kind).toBe('folder');
    expect(pathInfo(path.join(dir, 'gone.png')).kind).toBe('missing');
    expect(pathInfo('relative.png').kind).toBe('missing');
    expect(pathInfo('~/x').path).toBe(path.join(os.homedir(), 'x'));
  });
});
