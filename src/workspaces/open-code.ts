import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { findTool } from './pr.js';

/** Editors that open a file at a line, in the order Beluga tries them: how each is told the line. */
const EDITORS: readonly { readonly bin: string; readonly args: (file: string, line?: number) => string[] }[] = [
  { bin: 'cursor', args: (f, l) => (l ? ['-g', `${f}:${l}`] : [f]) },
  { bin: 'code', args: (f, l) => (l ? ['-g', `${f}:${l}`] : [f]) },
  { bin: 'zed', args: (f, l) => [l ? `${f}:${l}` : f] },
];

/** The first editor here that can jump to a line → the command to run (undefined: none; open it the system's way). */
export function editorCommand(file: string, line?: number, find: (name: string) => string | undefined = findTool): { cmd: string; args: string[] } | undefined {
  for (const e of EDITORS) {
    const cmd = find(e.bin);
    if (cmd) return { cmd, args: e.args(file, line) };
  }
  return undefined;
}

/** `file` in `root`, as a full path: never outside it. */
export async function fileIn(root: string, file: string): Promise<string> {
  const base = await realpath(root);
  const real = await realpath(path.resolve(base, file)).catch(() => {
    throw new Error(`${file} isn’t in this worktree`);
  });
  const rel = path.relative(base, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} isn’t in this worktree`);
  return real;
}

/** Open a worktree's file in your editor at a line (Cursor, VS Code or Zed), or with its default app. */
export async function openCode(root: string, file: string, line: number | undefined, fallback: (file: string) => void): Promise<void> {
  const full = await fileIn(root, file);
  const editor = editorCommand(full, line);
  if (!editor) return fallback(full);
  const child = spawn(editor.cmd, editor.args, { cwd: root, detached: true, stdio: 'ignore' });
  child.on('error', () => fallback(full));
  child.unref();
}
