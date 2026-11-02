import { describe, expect, it } from 'vitest';
import { RefTable } from '../src/companion/files.js';
import { withPictures } from '../src/companion/views.js';

/** Pictures Claude showed by a path on the Mac reach the phone as refs it can fetch (BLG-256). */
describe('withPictures', () => {
  const prose = (text: string) => ({ text, code: [] });
  const table = () => new RefTable(() => 'abcdefgh1234');

  it('turns a picture path on the Mac into a ref, keeping its words', () => {
    const refs = table();
    const out = withPictures(prose('Home, light\n\n![Home, light](/Users/k/p/.beluga/scratch/home-light.png)'), refs);
    expect(out.text).toBe('Home, light\n\n![Home, light](out:abcdefgh1234)');
    expect(refs.resolve('out:abcdefgh1234')?.path).toBe('/Users/k/p/.beluga/scratch/home-light.png');
  });

  it('reads a path with spaces in angle brackets, and file:// links', () => {
    expect(withPictures(prose('![a](</Users/k/My Shots/a.png>)'), table()).text).toBe('![a](out:abcdefgh1234)');
    expect(withPictures(prose('![a](file:///tmp/a%20b.jpg)'), table()).text).toBe('![a](out:abcdefgh1234)');
  });

  it('leaves web pictures, relative paths and non-pictures as written', () => {
    for (const t of ['![a](https://x.dev/a.png)', '![a](shots/a.png)', '![a](/Users/k/notes.txt)', 'no pictures']) {
      expect(withPictures(prose(t), table()).text).toBe(t);
    }
  });
});
