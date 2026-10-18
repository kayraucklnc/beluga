import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentLabel,
  chipText,
  droppedImagePaths,
  expandChips,
  formatBytes,
  importImage,
  insertChip,
  linkedImages,
  mediaTypeOf,
  publishForRoom,
  registerAttachment,
} from '../src/core/attachments.js';
import { imageContent } from '../src/agent/runner.js';

describe('image chips', () => {
  it('inserts a chip at the cursor with spacing', () => {
    expect(insertChip('', 0, '[image 1]')).toEqual({ buffer: '[image 1] ', cursor: 10 });
    expect(insertChip('look', 4, '[image 2]')).toEqual({ buffer: 'look [image 2] ', cursor: 15 });
    expect(insertChip('a  b', 2, '[image 3]')).toEqual({ buffer: 'a [image 3] b', cursor: 12 });
  });

  it('turns chips into image links on send, leaving unknown ones', () => {
    const a = registerAttachment('/x/attachments/20260101-1.png', 120 * 1024);
    expect(attachmentLabel(a)).toBe(`📎 image ${a.n} (png, 120K)`);
    const out = expandChips(`what is this? ${chipText(a.n)} and [image 999]`, 'me');
    expect(out.text).toBe(`what is this? [📎 image ${a.n} (png, 120K)](klaud-attachment:me/20260101-1.png) and [image 999]`);
    expect(out.attachments).toEqual([a]);
    expect(formatBytes(500)).toBe('500B');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0M');
  });

  it('recognizes dragged-in image paths', () => {
    const exists = (p: string) => p.startsWith('/img/');
    expect(droppedImagePaths('/img/My\\ Shot.png ', exists)).toEqual(['/img/My Shot.png']);
    expect(droppedImagePaths("'/img/a b.jpg' /img/c.gif", exists)).toEqual(['/img/a b.jpg', '/img/c.gif']);
    expect(droppedImagePaths('file:///img/x%20y.png', exists)).toEqual(['/img/x y.png']);
    expect(droppedImagePaths('/img/notes.txt', exists)).toBeUndefined();
    expect(droppedImagePaths('/other/a.png', exists)).toBeUndefined();
    expect(droppedImagePaths('hello world', exists)).toBeUndefined();
    expect(droppedImagePaths('', exists)).toBeUndefined();
  });
});

describe('images for Claude', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'klaud-att-'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  writeFileSync(path.join(dir, 'a.png'), png);
  mkdirSync(path.join(dir, 'room'));
  writeFileSync(path.join(dir, 'room', 'b.jpg'), png);

  it('finds only linked images that are in the attachments folder', () => {
    const prompt = '[x](klaud-attachment:me/a.png) [y](klaud-attachment:me/b.jpg) [z](klaud-attachment:me/missing.png) [w](klaud-attachment:me/notes.txt)';
    expect(linkedImages(prompt, dir)).toEqual([path.join(dir, 'a.png'), path.join(dir, 'room', 'b.jpg')]);
    expect(linkedImages('klaud-attachment:me/../secret.png', dir)).toEqual([]);
    expect(mediaTypeOf('a.JPG')).toBe('image/jpeg');
  });

  it('sends images as content blocks next to the text', async () => {
    expect(imageContent('hi', [])).toBe('hi');
    const content = imageContent('hi', [path.join(dir, 'a.png')]) as Array<{ type: string; source?: { data: string; media_type: string } }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(content[1]?.source).toEqual({ type: 'base64', media_type: 'image/png', data: png.toString('base64') });
  });

  it('copies images in, and out for the room', async () => {
    const copy = await importImage(path.join(dir, 'a.png'), path.join(dir, 'in'));
    expect(readFileSync(copy)).toEqual(png);
    const a = registerAttachment(copy, png.length);
    const name = publishForRoom(a, path.join(dir, 'out'));
    expect(readFileSync(path.join(dir, 'out', name))).toEqual(png);
  });
});
