import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Board } from '../src/core/board/board.js';
import type { Actor, Proof } from '../src/core/board/model.js';
import { isKept, keepProofFile, keepProofFiles, proofFolder } from '../src/core/board/proof-files.js';
import { Store, initialState } from '../src/core/store.js';

/** Proof files outlive the worktree they were made in (BLG-4). */

const claude: Actor = { kind: 'claude', owner: 'p-me', ownerName: 'Kay' };
const dirs: string[] = [];
const tmp = (name: string): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), `beluga-${name}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A worktree with a screenshot in its scratch folder. */
function worktree(): { dir: string; shot: string } {
  const dir = tmp('wt');
  const shot = path.join(dir, '.beluga', 'scratch', 'after', 'dark.png');
  mkdirSync(path.dirname(shot), { recursive: true });
  writeFileSync(shot, 'png-bytes');
  return { dir, shot };
}

const proof = (over: Partial<Proof>): Proof => ({ id: 'p_1', kind: 'image', title: 'Dark', at: 1, by: claude, ...over });

function setup(home: string) {
  const store = new Store(initialState('room'));
  store.dispatch({ type: 'projects', projects: [{ id: 'api', name: 'bob-api', root: '/tmp/bob-api', base: 'main', workspaces: [] }] });
  const board = new Board({ store, dir: home, projectName: () => 'bob-api', saveDelayMs: 0 });
  return { store, board };
}

describe('keeping a proof file', () => {
  it('copies it into the task’s folder and points there, remembering where it came from', () => {
    const home = tmp('home');
    const { shot } = worktree();
    const kept = keepProofFile(proof({ path: shot }), 'i_1', home);
    expect(kept.path).toBe(path.join(proofFolder(home, 'i_1'), 'p_1-dark.png'));
    expect(kept.from).toBe(shot);
    expect(readFileSync(kept.path!, 'utf8')).toBe('png-bytes');
    expect(isKept(home, kept.path!)).toBe(true);
    // Kept already: the same object back.
    expect(keepProofFile(kept, 'i_1', home)).toBe(kept);
  });

  it('a file that’s nowhere is marked gone (and found again when it comes back)', () => {
    const home = tmp('home');
    const missing = proof({ path: '/nowhere/at/all.png' });
    const gone = keepProofFile(missing, 'i_1', home);
    expect(gone.gone).toBe(true);
    expect(gone.path).toBe('/nowhere/at/all.png');
    const { shot } = worktree();
    const back = keepProofFile({ ...gone, path: shot }, 'i_1', home);
    expect(back.gone).toBeUndefined();
    expect(isKept(home, back.path!)).toBe(true);
  });

  it('leaves links, graphs, text and folders alone', () => {
    const home = tmp('home');
    const url = proof({ kind: 'url', url: 'https://x.dev' });
    const text = proof({ kind: 'text', body: 'ok' });
    expect(keepProofFile(url, 'i_1', home)).toBe(url);
    expect(keepProofFile(text, 'i_1', home)).toBe(text);
    const folder = proof({ kind: 'file', path: tmp('folder') });
    expect(keepProofFile(folder, 'i_1', home)).toBe(folder);
  });

  it('only what’s in a worktree about to go, when asked so', () => {
    const home = tmp('home');
    const a = worktree();
    const b = worktree();
    const list = [proof({ id: 'p_a', path: a.shot }), proof({ id: 'p_b', path: b.shot })];
    const next = keepProofFiles(list, 'i_1', home, a.dir);
    expect(isKept(home, next[0]!.path!)).toBe(true);
    expect(next[1]).toBe(list[1]);
    expect(keepProofFiles(next, 'i_1', home, a.dir)).toBe(next);
  });
});

describe('the board keeps proof files', () => {
  it('at attach time: the screenshot loads after its worktree is removed', () => {
    const home = tmp('home');
    const { board } = setup(home);
    const issue = board.create({ projectId: 'api', title: 'Dark mode' }, claude);
    const { dir, shot } = worktree();
    const next = board.addProof(issue.id, { kind: 'image', title: 'Dark', path: shot }, claude);
    rmSync(dir, { recursive: true, force: true });
    const p = next.proof[0]!;
    expect(p.from).toBe(shot);
    expect(readFileSync(p.path!, 'utf8')).toBe('png-bytes');
  });

  it('before a worktree goes, proofs still pointing into it are moved; afterwards missing ones are marked gone', () => {
    const home = tmp('home');
    const { dir, shot } = worktree();
    // A board saved before proofs were kept: it points into the worktree.
    const issue = { id: 'i_1', key: 'BOB-1', number: 1, projectId: 'api', title: 'Old', status: 'done', createdAt: 1, updatedAt: 1, createdBy: claude, proof: [proof({ path: shot }), proof({ id: 'p_2', path: '/gone/long/ago.png' })] };
    writeFileSync(path.join(home, 'board.json'), JSON.stringify({ version: 1, projects: { api: { prefix: 'BOB', next: 2 } }, issues: [issue] }));
    const { board, store } = setup(home);
    // On start: copied while it's there; the one already gone says so.
    const [kept, gone] = board.need('BOB-1').proof;
    expect(isKept(home, kept!.path!)).toBe(true);
    expect(gone).toMatchObject({ gone: true, path: '/gone/long/ago.png' });
    expect(store.getState().board.issues[0]!.proof[0]!.path).toBe(kept!.path);
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(kept!.path!)).toBe(true);
  });

  it('keepProofs(within) copies what is in that folder, quietly', () => {
    const home = tmp('home');
    const { board } = setup(home);
    const issue = board.create({ projectId: 'api', title: 'Old' }, claude);
    const { dir, shot } = worktree();
    // Attached before proofs were kept: still in the worktree.
    (board as unknown as { issues: Array<{ id: string; proof: Proof[] }> }).issues.find((i) => i.id === issue.id)!.proof.push(proof({ path: shot }));
    const before = board.need(issue.id);
    expect(board.keepProofs(tmp('elsewhere'))).toBe(0);
    expect(board.keepProofs(dir)).toBe(1);
    const after = board.need(issue.id);
    expect(isKept(home, after.proof[0]!.path!)).toBe(true);
    expect(after.activity).toHaveLength(before.activity.length);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('removing a proof (or its task) throws its kept copy away', () => {
    const home = tmp('home');
    const { board } = setup(home);
    const issue = board.create({ projectId: 'api', title: 'Dark mode' }, claude);
    const { shot } = worktree();
    const p = board.addProof(issue.id, { kind: 'image', title: 'Dark', path: shot }, claude).proof[0]!;
    board.removeProof(issue.id, p.id, claude);
    expect(existsSync(p.path!)).toBe(false);
    expect(existsSync(shot)).toBe(true);
    const q = board.addProof(issue.id, { kind: 'image', title: 'Dark', path: shot }, claude).proof[0]!;
    board.remove(issue.id);
    expect(existsSync(q.path!)).toBe(false);
    expect(existsSync(proofFolder(home, issue.id))).toBe(false);
  });
});
