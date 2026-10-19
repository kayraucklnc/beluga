import { describe, expect, it } from 'vitest';
import { imageSource, messageImages } from '../packages/mac/src/chat/md-images.js';

/** Images in a chat message's Markdown: files on this Mac by path, web images, and the rest. */
describe('chat Markdown images', () => {
  it('reads a local path, with or without <…>, file:// and spaces', () => {
    expect(imageSource('/Users/k/.context/shot.png')).toEqual({ kind: 'local', path: '/Users/k/.context/shot.png' });
    expect(imageSource('file:///Users/k/a%20b.PNG')).toEqual({ kind: 'local', path: '/Users/k/a b.PNG' });
    expect(imageSource('https://example.com/x.png')).toEqual({ kind: 'remote', url: 'https://example.com/x.png' });
    // Not an image, relative, or another scheme: nothing to show.
    expect(imageSource('/Users/k/notes.md').kind).toBe('other');
    expect(imageSource('shot.png').kind).toBe('other');
    expect(imageSource('javascript:alert(1)').kind).toBe('other');
  });

  it('lists a message’s local images in order, once each, named by their alt text or file', () => {
    const text = [
      '![README preview](</Users/k/.context/readme.png>)',
      '![](/Users/k/.context/pdf.png "title")',
      '![again](/Users/k/.context/readme.png) ![web](https://e.com/a.png)',
      '`![code](/Users/k/no.png)`',
    ].join('\n');
    const images = messageImages(text);
    expect(images.map((i) => [i.local, i.label])).toEqual([
      ['/Users/k/.context/readme.png', 'README preview'],
      ['/Users/k/.context/pdf.png', 'pdf.png'],
    ]);
    expect(images[0]!.href).toBe('local:/Users/k/.context/readme.png');
  });
});
