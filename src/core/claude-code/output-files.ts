import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSecretPath } from '../shares.js';
import { redactSecrets } from '../../shared/steps.js';
import { AGENT_SCRATCH_DIR, agentScratchName } from '../../shared/scratch-dir.js';
import type { CcOutput, CcOutputFile } from './model.js';
import { MAX_OUTPUTS, type OutputRef, outputKind } from './outputs.js';

/**
 * An agent's outputs on disk (outputs.ts finds them in its transcript): which are still there, its
 * own scratch folder's files, and one file's contents to show. Only ever files the agent itself
 * mentioned or saved to its folder; never secrets; never through a link.
 */

/** Pictures bigger than this aren't sent to the screen (open them with their app). */
const MAX_IMAGE = 20 * 1024 * 1024;
/** Videos up to this play in the Mac's Outputs (bigger: open them with their app). */
export const MAX_VIDEO = 64 * 1024 * 1024;
/** Text shown from the start of a file. */
const MAX_TEXT = 512 * 1024;
const SCRATCH_DEPTH = 3;
/** Claude Code's own files (its login, every transcript): never shown, even when an agent read one. */
const CLAUDE_OWN = /(^|\/)\.claude(\.json$|\/)/;

/** Where a path really is (links resolved), or undefined when it's gone. */
const realOf = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/** Never shown: a secret, or Claude Code's own files, by the path given or where it really leads. */
const off = (p: string, real: string): boolean => [p, real].some((x) => isSecretPath(x) || CLAUDE_OWN.test(x));

const MIME: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** What the Mac's web view plays (BLG-100); a codec it lacks shows the fallback there. */
const VIDEO_MIME: Readonly<Record<string, string>> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

/** A sub-agent's own scratch folder, from where its session runs and the call that started it. */
export const agentScratchDir = (sessionCwd: string, toolUseId: string): string => path.join(sessionCwd, AGENT_SCRATCH_DIR, agentScratchName(toolUseId));

/** The folder is real all the way down from the session's folder (no link out of it). */
function noLinks(root: string, dir: string): boolean {
  let at = root;
  for (const part of path.relative(root, dir).split(path.sep)) {
    at = path.join(at, part);
    try {
      if (!lstatSync(at).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Files in an agent's scratch folder (no links followed). */
function scratchFiles(root: string, dir: string): OutputRef[] {
  if (!noLinks(root, dir)) return [];
  const out: OutputRef[] = [];
  const walk = (at: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= MAX_OUTPUTS) return;
      const p = path.join(at, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory() && depth < SCRATCH_DEPTH) walk(p, depth + 1);
      else if (st?.isFile()) out.push({ path: p, how: 'wrote', ts: st.mtimeMs });
    }
  };
  walk(dir, 1);
  return out;
}

/** What's still there of what an agent mentioned, plus its folder's files: newest first. */
export function outputsOnDisk(refs: readonly OutputRef[], scratch?: { root: string; dir: string }): CcOutput[] {
  const all = new Map<string, OutputRef>();
  for (const r of [...(scratch ? scratchFiles(scratch.root, scratch.dir) : []), ...refs]) if (!all.has(r.path)) all.set(r.path, r);
  const out: CcOutput[] = [];
  for (const r of all.values()) {
    const real = realOf(r.path);
    if (!real || off(r.path, real)) continue;
    const st = statSync(real, { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    out.push({ path: r.path, how: r.how, kind: outputKind(r.path), size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, MAX_OUTPUTS);
}

/** The start of a file, read through one handle that never follows a link (or waits on a pipe). */
function head(file: string, bytes: number): { buf: Buffer; size: number } | undefined {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    const buf = Buffer.alloc(Math.min(bytes, st.size));
    return { buf: buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)), size: st.size };
  } finally {
    closeSync(fd);
  }
}

/** The end of a text file (secrets redacted by the caller), through a handle that never follows a link. */
export function readTail(file: string, bytes: number): { text: string; size: number; mtime: number } | undefined {
  const real = realOf(file);
  if (!real || off(file, real)) return undefined;
  try {
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return undefined;
      const start = Math.max(0, st.size - bytes);
      const buf = Buffer.alloc(st.size - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      return { text: buf.subarray(0, n).toString('utf8'), size: st.size, mtime: Math.round(st.mtimeMs) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** One output's contents, to show it. */
export function readOutput(o: CcOutput): CcOutputFile {
  try {
    const real = realOf(o.path);
    if (!real || off(o.path, real)) return o;
    if (o.kind === 'image') {
      const mime = MIME[path.extname(o.path).toLowerCase()];
      const got = mime && o.size <= MAX_IMAGE ? head(real, MAX_IMAGE + 1) : undefined;
      return got && got.size <= MAX_IMAGE ? { ...o, mime, data: got.buf.toString('base64') } : o;
    }
    if (o.kind === 'video') {
      const mime = VIDEO_MIME[path.extname(o.path).toLowerCase()];
      const got = mime && o.size <= MAX_VIDEO ? head(real, MAX_VIDEO + 1) : undefined;
      return got && got.size <= MAX_VIDEO ? { ...o, mime, data: got.buf.toString('base64') } : o;
    }
    if (o.kind === 'json' || o.kind === 'markdown' || o.kind === 'text') {
      const got = head(real, MAX_TEXT);
      if (!got) return o;
      return { ...o, text: redactSecrets(got.buf.toString('utf8')), ...(got.size > MAX_TEXT ? { truncated: true } : {}) };
    }
  } catch {
    // Gone or unreadable since it was listed: show what's known.
  }
  return o;
}
