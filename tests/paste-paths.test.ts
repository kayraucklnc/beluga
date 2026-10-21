import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathsInPaste } from '../packages/mac/src/chat/paste-paths-model.js';
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
