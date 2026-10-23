import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { refKey, referencedImages } from '../packages/mac/src/chat/image-refs.js';
import { chipText, expandChips, reattach, registerAttachment } from '../src/core/attachments.js';
import { imageLinksAsWords, imageLinksIn } from '../src/shared/attachment-links.js';

describe('"[image N]" in the message box is one thing', () => {
  const text = 'see [image 1] here';

  it('goes whole on Backspace from its end or from inside it, with one space', () => {
    expect(refKey(text, 13, 13, 'Backspace')).toEqual({ kind: 'delete', start: 4, end: 14, images: [1] });
    expect(refKey(text, 9, 9, 'Backspace')).toEqual({ kind: 'delete', start: 4, end: 14, images: [1] });
    // Right before it, Backspace takes the space as usual.
    expect(refKey(text, 4, 4, 'Backspace')).toBeUndefined();
  });

  it('goes whole on Delete from its start', () => {
    expect(refKey(text, 4, 4, 'Delete')).toEqual({ kind: 'delete', start: 4, end: 14, images: [1] });
    expect(refKey(text, 13, 13, 'Delete')).toBeUndefined();
  });

  it('a selection that cuts into it takes all of it', () => {
    expect(refKey(text, 0, 7, 'Backspace')).toEqual({ kind: 'delete', start: 0, end: 13, images: [1] });
    expect(refKey(text, 0, 3, 'Backspace')).toBeUndefined();
  });

  it('the arrows step over it', () => {
    expect(refKey(text, 13, 13, 'ArrowLeft')).toEqual({ kind: 'move', cursor: 4 });
    expect(refKey(text, 4, 4, 'ArrowRight')).toEqual({ kind: 'move', cursor: 13 });
    expect(refKey(text, 2, 2, 'ArrowRight')).toBeUndefined();
  });

  it('lists the images the words reference', () => {
    expect(referencedImages('[image 2] and [image 10]')).toEqual([2, 10]);
  });
});

describe('a sent image back in the box', () => {
  const link = (n: number, file: string, owner = 'me'): string => `[📎 image ${n} (png, 154K)](klaud-attachment:${owner}/${file})`;

  it('finds each link and where it sits', () => {
    const text = `look ${link(1, 'a.png')} and ${link(2, 'b.png', 'bob')}`;
    const found = imageLinksIn(text);
    expect(found.map((f) => [f.owner, f.file, f.label])).toEqual([['me', 'a.png', 'image 1'], ['bob', 'b.png', 'image 2']]);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(link(1, 'a.png'));
  });

  it('reads as words in a one-line preview', () => {
    expect(imageLinksAsWords(`fix this ${link(1, 'a.png')}`)).toBe('fix this 📎 image 1');
  });

  it('keeps its number while the session knows the file, else gets a new one', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reattach-'));
    const file = path.join(dir, 'shot.png');
    writeFileSync(file, 'png');
    const a = registerAttachment(file, 3);
    expect(reattach('shot.png', dir)?.n).toBe(a.n);
    writeFileSync(path.join(dir, 'older.png'), 'png');
    expect(reattach('older.png', dir)).toMatchObject({ path: path.join(dir, 'older.png'), size: 3 });
    expect(reattach('missing.png', dir)).toBeUndefined();
    expect(reattach('../secret.png', dir)).toBeUndefined();
  });

  it('only waiting images become links: an "[image N]" typed by hand stays words', () => {
    const a = registerAttachment('/x/attachments/typed.png', 10);
    const b = registerAttachment('/x/attachments/kept.png', 10);
    const out = expandChips(`${chipText(a.n)} ${chipText(b.n)}`, 'me', undefined, [b.n]);
    expect(out.text).toBe(`${chipText(a.n)} [📎 image ${b.n} (png, 10B)](klaud-attachment:me/kept.png)`);
  });
});
