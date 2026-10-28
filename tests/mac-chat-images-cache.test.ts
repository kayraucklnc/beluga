import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Mac app's alias for the core; only its scheme is used here.
vi.mock('@beluga/core/attachment-share.js', () => ({ ATTACHMENT_SCHEME: 'beluga-attachment://' }));

/** A fake core: every image is a tiny PNG; counts the reads. */
const reads: string[] = [];
const api = {
  session: { localLocation: async (p: string) => ({ owner: '', share: '', path: p }) },
  files: { readImageFile: async (at: { path: string }) => (reads.push(at.path), { data: btoa('png'), mediaType: 'image/png' }) },
  attachments: { read: async () => ({ data: btoa('png'), mime: 'image/png' }) },
} as never;
/** Through a variable: the root typecheck can't follow the Mac app's @beluga paths (its own tsc checks the file). */
const MODULE = '../packages/mac/src/chat/images.js';
type Images = { loadImage: (api: never, image: object, size: 'thumb' | 'full') => Promise<string>; holdImage: (api: never, image: object, size: 'thumb' | 'full') => { url: Promise<string>; release: () => void } };
const images = (): Promise<Images> => import(MODULE) as Promise<Images>;
const img = (n: number) => ({ href: `local:/shots/${n}.png`, owner: '', file: '', local: `/shots/${n}.png` });

let made = 0;
const revoked = new Set<string>();

beforeEach(() => {
  made = 0;
  revoked.clear();
  reads.length = 0;
  vi.resetModules();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++made}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.add(u));
  // No decoder here: shrink keeps the picture as it is.
  vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('no decoder')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('chat images are let go once the window has enough (BLG-367)', () => {
  it('keeps a picture once read, and reads it again only after it was let go', async () => {
    const { loadImage } = await images();
    const a = await loadImage(api, img(1), 'thumb');
    expect(await loadImage(api, img(1), 'thumb')).toBe(a);
    expect(reads).toEqual(['/shots/1.png']);
  });

  it('lets the oldest full-size pictures go past a few, but never one on screen', async () => {
    const { holdImage, loadImage } = await images();
    const shown = holdImage(api, img(0), 'full');
    const first = await shown.url;
    const urls = [];
    for (let n = 1; n <= 10; n++) urls.push(await loadImage(api, img(n), 'full'));
    expect(revoked.has(first)).toBe(false);
    expect(revoked.size).toBe(6);
    expect(revoked.has(urls[0]!)).toBe(true);
    expect(revoked.has(urls[9]!)).toBe(false);
    // Off screen: it goes too, the next time the window has too many.
    shown.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(revoked.has(first)).toBe(true);
  });

  it('keeps thumbnails and full pictures apart: opening the lightbox reads the full one', async () => {
    const { loadImage } = await images();
    const thumb = await loadImage(api, img(1), 'thumb');
    const full = await loadImage(api, img(1), 'full');
    expect(full).not.toBe(thumb);
    expect(reads).toHaveLength(2);
  });
});
