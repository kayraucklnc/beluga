import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileServer, RefTable, allowed, mimeOf, quickLookPoster } from '../src/companion/files.js';
import { cantPlay, isGif, mediaPath, videoFormat } from '../src/companion/media.js';
import { COMPANION_PIECE, OutputView } from '../src/companion/protocol.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'beluga-files-'));
  dirs.push(root);
  const project = path.join(root, 'project');
  const scratch = path.join(project, '.beluga', 'scratch');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(path.join(project, 'src', 'app.ts'), 'export const secret = 1;\n');
  writeFileSync(path.join(project, 'notes.md'), '# not an output\n');
  writeFileSync(path.join(scratch, 'run.log'), 'line one\ntoken=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n');
  writeFileSync(path.join(scratch, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(path.join(project, '.env'), 'KEY=1\n');
  return { root, project, scratch };
}

let n = 0;
const refs = (): RefTable => new RefTable(() => `test${String(n++).padStart(6, '0')}`);

describe('refs', () => {
  it('hands out stable refs for outputs only', () => {
    const { project, scratch } = fixture();
    const table = refs();
    const log = table.output(path.join(scratch, 'run.log'), { cwd: project, size: 10, ts: 5 });
    expect(log && OutputView.parse(log)).toEqual(log);
    expect(log).toMatchObject({ name: 'run.log', kind: 'text', size: 10, ts: 5 });
    // The same path keeps its ref (views that didn't change hash the same).
    expect(table.refFor(path.join(scratch, 'run.log'), project)).toBe(log?.ref);
    // Source code, text inside the project outside the output folders, and secrets never get one.
    expect(table.refFor(path.join(project, 'src', 'app.ts'), project)).toBeUndefined();
    expect(table.refFor(path.join(project, 'notes.md'), project)).toBeUndefined();
    expect(table.refFor(path.join(project, '.env'), project)).toBeUndefined();
    expect(table.refFor('relative.png')).toBeUndefined();
    // Pictures anywhere.
    expect(table.output(path.join(project, 'src', 'logo.png'), { cwd: project })?.kind).toBe('image');
  });

  it('refuses a link that leads to a secret', () => {
    const { project, scratch } = fixture();
    symlinkSync(path.join(project, '.env'), path.join(scratch, 'env.log'));
    expect(allowed(path.join(scratch, 'env.log'), project)).toBe(false);
    expect(allowed(path.join(scratch, 'run.log'), project)).toBe(true);
  });
});

describe('the file server', () => {
  it('serves text with secrets redacted, full bytes, and thumbnails through the thumbnailer', async () => {
    const { root, project, scratch } = fixture();
    const table = refs();
    const made: string[] = [];
    const server = new FileServer({
      refs: table,
      thumbsDir: path.join(root, 'thumbs'),
      thumbnail: async (src, dest) => {
        made.push(src);
        copyFileSync(src, dest);
      },
    });
    const log = table.refFor(path.join(scratch, 'run.log'), project)!;
    const text = await server.piece(log, 'text', 0);
    expect(text.eof).toBe(true);
    expect(text.mime).toBe('text/plain');
    const words = Buffer.from(text.b64, 'base64').toString('utf8');
    expect(words).toContain('line one');
    expect(words).not.toContain('sk-ant-api03');

    const shot = table.refFor(path.join(scratch, 'shot.png'), project)!;
    const full = await server.piece(shot, 'full', 0);
    expect(full).toMatchObject({ off: 0, eof: true, size: 8, mime: 'image/png' });
    const thumb = await server.piece(shot, 'thumb', 0);
    expect(thumb.mime).toBe('image/jpeg');
    await server.piece(shot, 'thumb', 0);
    // Made once, then cached.
    expect(made).toHaveLength(1);
    await expect(server.piece(log, 'thumb', 0)).rejects.toThrow(/pictures/);
    await expect(server.piece(shot, 'text', 0)).rejects.toThrow(/not text/);
    await expect(server.piece('out:nothing-here', 'full', 0)).rejects.toThrow(/no longer offered/);
  });

  it('sends big files in pieces', async () => {
    const { project, scratch } = fixture();
    const table = refs();
    const server = new FileServer({ refs: table, thumbsDir: path.join(project, 'thumbs') });
    writeFileSync(path.join(scratch, 'big.log'), 'x'.repeat(COMPANION_PIECE + 100));
    const ref = table.refFor(path.join(scratch, 'big.log'), project)!;
    const first = await server.piece(ref, 'full', 0);
    expect(first.eof).toBe(false);
    expect(Buffer.from(first.b64, 'base64').length).toBe(COMPANION_PIECE);
    const second = await server.piece(ref, 'full', COMPANION_PIECE);
    expect(second.eof).toBe(true);
    expect(Buffer.from(second.b64, 'base64').length).toBe(100);
  });

  it('checks again when fetched: a file that became a link to a secret is refused', async () => {
    const { project, scratch } = fixture();
    const table = refs();
    const server = new FileServer({ refs: table, thumbsDir: path.join(project, 'thumbs') });
    const p = path.join(scratch, 'later.log');
    writeFileSync(p, 'fine');
    const ref = table.refFor(p, project)!;
    rmSync(p);
    symlinkSync(path.join(project, '.env'), p);
    await expect(server.piece(ref, 'text', 0)).rejects.toThrow(/can't be opened/);
  });
});

describe('videos (BLG-100, BLG-103)', () => {
  it('are outputs anywhere, with their own mime and a poster thumbnail', async () => {
    const { root, project, scratch } = fixture();
    const table = refs();
    for (const name of ['clip.mp4', 'clip.mov', 'clip.m4v', 'clip.webm']) {
      writeFileSync(path.join(scratch, name), Buffer.alloc(300_000, 7));
      expect(table.output(path.join(scratch, name), { cwd: project })?.kind).toBe('video');
    }
    // Inside the project too (media is never source).
    expect(table.output(path.join(project, 'src', 'demo.mov'), { cwd: project })?.kind).toBe('video');
    expect(mimeOf('a.MOV')).toBe('video/quicktime');
    expect(mimeOf('a.m4v')).toBe('video/x-m4v');
    expect(mimeOf('a.webm')).toBe('video/webm');
    const posters: string[] = [];
    const server = new FileServer({
      refs: table,
      thumbsDir: path.join(root, 'thumbs'),
      thumbnail: async () => {
        throw new Error('not a picture');
      },
      poster: async (src, dest) => {
        posters.push(src);
        writeFileSync(dest, 'jpeg');
      },
    });
    const mov = table.refFor(path.join(scratch, 'clip.mov'), project)!;
    expect(await server.piece(mov, 'thumb', 0)).toMatchObject({ mime: 'image/jpeg', eof: true });
    expect(posters).toEqual([path.join(scratch, 'clip.mov')]);
    // The bytes in pieces from any offset: what the phone's player streams from.
    const mid = await server.piece(mov, 'full', COMPANION_PIECE);
    expect(mid).toMatchObject({ off: COMPANION_PIECE, eof: true, size: 300_000, mime: 'video/quicktime' });
    expect(Buffer.from(mid.b64, 'base64').length).toBe(300_000 - COMPANION_PIECE);
    await expect(server.piece(mov, 'text', 0)).rejects.toThrow(/not text/);
  });

  it('says which play where, and never asks Quick Look for a WebM poster', async () => {
    expect(videoFormat('Clip.MOV')).toMatchObject({ label: 'MOV', mime: 'video/quicktime' });
    expect(videoFormat('notes.txt')).toBeUndefined();
    expect(isGif('party.GIF')).toBe(true);
    expect(cantPlay('a.mp4', 'android')).toBeUndefined();
    expect(cantPlay('a.mov', 'ios')).toBeUndefined();
    expect(cantPlay('a.webm', 'android')).toBeUndefined();
    expect(cantPlay('a.webm', 'ios')).toMatch(/WebM/);
    expect(cantPlay('a.avi', 'android')).toBeTruthy();
    expect(mediaPath('out:x', 'a.webm')).toBe('/out%3Ax/media.webm');
    await expect(quickLookPoster('/tmp/a.webm', '/tmp/a.jpg')).rejects.toThrow(/No poster/);
  });
});
