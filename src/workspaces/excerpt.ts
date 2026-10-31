import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isSecretPath } from '../core/shares.js';
import { MAX_REF_LINES } from '../shared/code-ref.js';

/** Lines of a file in a workspace, for a code block in chat or a PR thread. */
export interface Excerpt {
  /** Relative to the workspace. */
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly lines: readonly string[];
  /** How many lines the file has. */
  readonly total: number;
}

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Read lines `from`…`to` of `file` inside `root` (a worktree or project). Never outside it (not
 * through `..` or a symlink), never a secret (.env, keys), never a big or binary file.
 */
export async function readExcerpt(root: string, file: string, from = 1, to = from + 29): Promise<Excerpt> {
  const base = await realpath(root);
  const wanted = path.resolve(base, file.replace(/^\.\//, ''));
  const real = await realpath(wanted).catch(() => {
    throw new Error(`${file} isn’t in this worktree`);
  });
  const rel = path.relative(base, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('.git')) throw new Error(`${file} isn’t in this worktree`);
  // Inside the worktree only: worktrees themselves live in ~/.beluga, which counts as private as a whole.
  if (isSecretPath(rel)) throw new Error(`${file} may hold secrets, so it isn’t shown`);
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${file} isn’t a file`);
  if (info.size > MAX_BYTES) throw new Error(`${file} is too big to show`);
  const text = await readFile(real, 'utf8');
  if (text.includes('\u0000')) throw new Error(`${file} isn’t text`);
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  const total = all.length;
  const start = Math.max(1, Math.min(from, total || 1));
  const end = Math.max(start, Math.min(to, total, start + MAX_REF_LINES - 1));
  return { path: rel.split(path.sep).join('/'), from: start, to: end, lines: all.slice(start - 1, end), total };
}
