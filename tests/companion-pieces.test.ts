import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileServer, RefTable } from '../src/companion/files.js';
import { COMPANION_PIECE } from '../src/companion/protocol.js';
import { Assembly, b64Bytes, progressText } from '../packages/companion/lib/pieces.js';

/**
 * BLG-106: a big picture comes in pieces, the phone asking for each next one (it used to stop after
 * the first 192 KB and spin on "Getting the full picture" for ever).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('paging a picture', () => {
  it('fetches a Retina-sized screenshot whole, piece after piece, from the real file server', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'beluga-pieces-'));
    dirs.push(root);
    const scratch = path.join(root, 'p', '.beluga', 'scratch');
    mkdirSync(scratch, { recursive: true });
    // About what a 5K Retina PNG weighs, and not a whole number of pieces.
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 12_345);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    writeFileSync(path.join(scratch, 'Screenshot.png'), bytes);
    const refs = new RefTable(() => 'shot');
    const server = new FileServer({ refs, thumbsDir: path.join(root, 'thumbs') });
    const ref = refs.refFor(path.join(scratch, 'Screenshot.png'), path.join(root, 'p'))!;

    const asm = new Assembly();
    const parts: Buffer[] = [];
    let off = 0;
    let asks = 0;
    for (;;) {
      asks++;
      const piece = await server.piece(ref, 'full', off);
      parts.push(Buffer.from(piece.b64, 'base64'));
      const step = asm.add(piece);
      if (step.t === 'fail') throw new Error(step.error);
      if (step.t === 'done') break;
      expect(step.off).toBe(off + COMPANION_PIECE);
      off = step.off;
      expect(asm.progress).toBeGreaterThan(0);
      expect(asm.progress).toBeLessThan(1);
    }
    expect(Buffer.concat(parts).equals(bytes)).toBe(true);
    expect(asks).toBe(Math.ceil(bytes.length / COMPANION_PIECE));
    expect(asm.progress).toBe(1);
  });

  it('fails in words, never waits for ever: out of order, too big, or a file that shrank', () => {
    expect(new Assembly().add({ off: 10, b64: 'AAAA', eof: false, size: 100 })).toMatchObject({ t: 'fail', error: /order/ });
    expect(new Assembly(1000).add({ off: 0, b64: 'AAAA', eof: false, size: 5000 })).toMatchObject({ t: 'fail', error: /Too big/ });
    expect(new Assembly().add({ off: 0, b64: '', eof: false, size: 100 })).toMatchObject({ t: 'fail', error: /changed/ });
    // A small picture: one piece and done.
    expect(new Assembly().add({ off: 0, b64: 'AAA=', eof: true, size: 2 })).toEqual({ t: 'done', got: 2, size: 2 });
  });

  it('counts base64 bytes and says how far it is', () => {
    expect(b64Bytes('')).toBe(0);
    expect(b64Bytes('AAAA')).toBe(3);
    expect(b64Bytes('AAA=')).toBe(2);
    expect(b64Bytes('AA==')).toBe(1);
    expect(progressText(0, undefined)).toBe('Getting the full picture');
    expect(progressText(512 * 1024, 1024 * 1024 - 1)).toMatch(/50%/);
    expect(progressText(2 * 1024 * 1024, 8.4 * 1024 * 1024)).toBe('Getting the full picture · 2.0 of 8.4 MB');
  });
});
