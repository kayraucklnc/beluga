import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Proof } from './model.js';

/**
 * Proof files outlive the worktree they were made in: a screenshot or file attached to a task is
 * copied into ~/.beluga/proof/<task id>/ at once, and the proof points at the copy (`from` says
 * where it came from). Proofs saved before that (still pointing into a worktree) are copied over
 * while their file is there (on start, and before a worktree is archived or deleted); one whose
 * file went before it could be is marked `gone`, so screens say so calmly instead of failing.
 */

export const PROOF_FOLDER = 'proof';
/** Bigger files stay where they are (a proof is a screenshot or a log, not a build). */
const MAX_BYTES = 200 * 1024 * 1024;

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Whether `file` is `folder` or somewhere inside it (links resolved). */
export function isInside(file: string, folder: string): boolean {
  const f = real(file);
  const d = real(folder);
  return f === d || f.startsWith(d + path.sep);
}

/** Where a task's proof files are kept. */
export const proofFolder = (home: string, issueId: string): string => path.join(home, PROOF_FOLDER, issueId);

/** The copy of one proof's file: its id first, so two files of the same name don't meet. */
export const keptPath = (home: string, issueId: string, proof: Pick<Proof, 'id'>, file: string): string => path.join(proofFolder(home, issueId), `${proof.id}-${path.basename(file)}`);

const hasFile = (proof: Proof): proof is Proof & { readonly path: string } => Boolean(proof.path) && (proof.kind === 'image' || proof.kind === 'file');

/** Whether a proof's file is one Beluga keeps (in ~/.beluga/proof). */
export const isKept = (home: string, file: string): boolean => isInside(file, path.join(home, PROOF_FOLDER));

/**
 * The proof with its file kept: copied into the task's folder when it's a file that's there (and
 * not too big), pointing at an earlier copy when there is one, and marked `gone` when its file is
 * nowhere. Returns the same object when nothing changed.
 */
export function keepProofFile(proof: Proof, issueId: string, home: string): Proof {
  if (!hasFile(proof)) return proof;
  const mark = (p: Proof, gone: boolean): Proof => {
    if (Boolean(p.gone) === gone) return p;
    const { gone: _, ...rest } = p;
    return gone ? { ...rest, gone: true } : rest;
  };
  if (isKept(home, proof.path)) return mark(proof, !existsSync(proof.path));
  const to = keptPath(home, issueId, proof, proof.path);
  const moved = (): Proof => mark({ ...proof, path: to, from: proof.from ?? proof.path }, false);
  if (existsSync(to)) return moved();
  let size: number;
  try {
    const st = statSync(proof.path);
    if (!st.isFile()) return mark(proof, false);
    size = st.size;
  } catch {
    return mark(proof, true);
  }
  if (size > MAX_BYTES) return mark(proof, false);
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(proof.path, to);
  } catch {
    // Can't copy (a full disk): it stays where it is, for now.
    return mark(proof, false);
  }
  return moved();
}

/**
 * A task's proof list with its files kept (see keepProofFile); `within`: only those whose file is
 * in this folder (a worktree about to go). The same array when nothing changed.
 */
export function keepProofFiles(list: readonly Proof[], issueId: string, home: string, within?: string): readonly Proof[] {
  let changed = false;
  const next = list.map((p) => {
    if (within && !(p.path && isInside(p.path, within))) return p;
    const kept = keepProofFile(p, issueId, home);
    if (kept !== p) changed = true;
    return kept;
  });
  return changed ? next : list;
}

/** Throw away a kept copy (its proof was removed); files elsewhere are never touched. */
export function dropKeptFile(home: string, file: string | undefined): void {
  if (!file || !isKept(home, file)) return;
  rmSync(file, { force: true });
}

/** Throw away a task's kept files (the task was deleted). */
export function dropProofFolder(home: string, issueId: string): void {
  rmSync(proofFolder(home, issueId), { recursive: true, force: true });
}
