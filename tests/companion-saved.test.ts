import { describe, expect, it } from 'vitest';
import { freeName, groups, split, topicsOf, totalBytes, type SavedFile } from '../packages/companion/lib/saved-list.js';
import { progressOf } from '../packages/companion/lib/pieces.js';

/** What the phone saved, and what goes when a conversation is archived on the Mac (BLG-122). */

const f = (name: string, topic: string | undefined, at: number, size = 100): SavedFile => ({ uri: `content://x/${name}`, name, kind: 'image', size, at, ...(topic ? { topic } : {}) });

describe('saved files', () => {
  it('never takes a name that is in the folder already', () => {
    expect(freeName('shot.png', new Set())).toBe('shot.png');
    expect(freeName('shot.png', new Set(['shot.png']))).toBe('shot (2).png');
    expect(freeName('shot.png', new Set(['shot.png', 'shot (2).png']))).toBe('shot (3).png');
    expect(freeName('notes', new Set(['notes']))).toBe('notes (2)');
    expect(freeName('a/b:c.txt', new Set())).toBe('a_b_c.txt');
    expect(freeName('  ', new Set())).toBe('file');
  });

  it('asks about each conversation once, and drops only the gone ones', () => {
    const list = [f('a.png', 'conv:ws:w1', 1), f('b.png', 'conv:ws:w1', 2), f('c.png', 'conv:ws:w2', 3), f('d.png', undefined, 4), f('e.png', 'chat:dm:x', 5)];
    expect(topicsOf(list)).toEqual(['conv:ws:w1', 'conv:ws:w2']);
    const { drop, keep } = split(list, ['conv:ws:w1']);
    expect(drop.map((s) => s.name)).toEqual(['a.png', 'b.png']);
    expect(keep.map((s) => s.name)).toEqual(['c.png', 'd.png', 'e.png']);
  });

  it('groups by conversation, the newest first, with their sizes', () => {
    const list = [f('a.png', 'conv:ws:w1', 1, 10), f('b.png', 'conv:ws:w2', 3, 20), f('c.png', 'conv:ws:w1', 5, 30)];
    const g = groups(list, (t) => t ?? 'Elsewhere');
    expect(g.map((x) => [x.key, x.bytes, x.files.map((s) => s.name)])).toEqual([
      ['conv:ws:w1', 40, ['c.png', 'a.png']],
      ['conv:ws:w2', 20, ['b.png']],
    ]);
    expect(totalBytes(list)).toBe(60);
  });

  it('says how far a save got', () => {
    expect(progressOf('Saving', 0, undefined)).toBe('Saving');
    expect(progressOf('Saving', 512, 1024)).toBe('Saving · 50%');
    expect(progressOf('Saving', 3 * 1024 * 1024, 12 * 1024 * 1024)).toBe('Saving · 3.0 of 12 MB');
  });
});
