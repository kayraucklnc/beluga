import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseProjectIcon, findProjectIcon, readProjectIcon, suggestProjects } from '../src/core/project-icons.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'klaud-icons-'));
const put = (root: string, rel: string, body = 'x'): string => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
};

describe('project icons', () => {
  it('finds the icon a project ships, best first', () => {
    const root = tmp();
    expect(findProjectIcon(root)).toBeUndefined();
    put(root, 'public/favicon.ico');
    expect(findProjectIcon(root)).toBe(path.join(root, 'public/favicon.ico'));
    put(root, 'src/app/icon.png');
    expect(findProjectIcon(root)).toBe(path.join(root, 'src/app/icon.png'));
    put(root, 'src-tauri/icons/icon.png');
    expect(findProjectIcon(root)).toBe(path.join(root, 'src-tauri/icons/icon.png'));
  });

  it('looks in monorepo apps and Xcode asset catalogs', () => {
    const mono = tmp();
    put(mono, 'apps/web/public/favicon.svg', '<svg/>');
    expect(findProjectIcon(mono)).toBe(path.join(mono, 'apps/web/public/favicon.svg'));
    const ios = tmp();
    put(ios, 'App/Assets.xcassets/AppIcon.appiconset/icon-1024.png');
    put(ios, 'App/Assets.xcassets/AppIcon.appiconset/icon-60@3x.png');
    expect(findProjectIcon(ios)).toBe(path.join(ios, 'App/Assets.xcassets/AppIcon.appiconset/icon-60@3x.png'));
  });

  it('prefers the icon you chose, and goes back to the project’s own', () => {
    const root = tmp();
    const icons = tmp();
    put(root, 'logo.svg', '<svg/>');
    expect(readProjectIcon(root, icons)).toMatchObject({ mime: 'image/svg+xml' });
    const mine = put(tmp(), 'mine.png', 'png');
    chooseProjectIcon(root, mine, icons);
    expect(readProjectIcon(root, icons)).toEqual({ mime: 'image/png', data: Buffer.from('png').toString('base64') });
    chooseProjectIcon(root, undefined, icons);
    expect(readProjectIcon(root, icons)?.mime).toBe('image/svg+xml');
    expect(() => chooseProjectIcon(root, put(tmp(), 'notes.txt'), icons)).toThrow(/PNG/);
  });
});

describe('suggestProjects', () => {
  it('lists git repos in code folders that are not projects yet, newest first', () => {
    const home = tmp();
    const a = path.dirname(put(home, 'Projects/a/.git/HEAD'));
    const b = path.dirname(put(home, 'code/team/b/.git/HEAD'));
    put(home, 'Projects/not-a-repo/readme.md');
    put(home, 'Projects/known/.git/HEAD');
    utimesSync(a, new Date(1000), new Date(1000));
    const found = suggestProjects([path.join(home, 'Projects/known')], home);
    expect(found.map((f) => f.name)).toEqual(['b', 'a']);
    expect(found[0]!.path).toBe(realpathSync.native(path.dirname(b)));
  });
});
