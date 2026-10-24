import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOutput } from '../src/core/claude-code/output-files.js';
import { isArtifact, outputKind } from '../src/core/claude-code/outputs.js';

/** BLG-100: the Mac's Outputs play an agent's videos inline (their bytes, like pictures; only so big). */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('videos in Outputs', () => {
  it('are outputs (MP4, M4V, MOV, WebM), and their bytes come with a type the web view plays', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-videos-'));
    dirs.push(dir);
    for (const [name, mime] of [
      ['demo.mp4', 'video/mp4'],
      ['demo.m4v', 'video/mp4'],
      ['Screen Recording.MOV', 'video/quicktime'],
      ['demo.webm', 'video/webm'],
    ] as const) {
      const p = path.join(dir, name);
      writeFileSync(p, Buffer.from('fake video bytes'));
      expect(outputKind(p)).toBe('video');
      expect(isArtifact(p, '/elsewhere')).toBe(true);
      const got = readOutput({ path: p, how: 'wrote', kind: 'video', size: 16, mtime: 1 });
      expect(got.mime).toBe(mime);
      expect(Buffer.from(got.data!, 'base64').toString()).toBe('fake video bytes');
    }
  });

  it('too big to play here: no bytes, so the preview offers its app', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-videos-'));
    dirs.push(dir);
    const p = path.join(dir, 'long.mov');
    writeFileSync(p, 'x');
    expect(readOutput({ path: p, how: 'wrote', kind: 'video', size: 65 * 1024 * 1024, mtime: 1 }).data).toBeUndefined();
  });
});
