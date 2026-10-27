import { isSecretPath } from '../core/shares.js';
import { needBoard } from '../core/board/registry.js';
import { syncOf } from '../core/board/sync/sync.js';
import type { Session } from '../core/session.js';
import type { Assignee } from '../core/board/model.js';
import type { Args, Method } from './api.js';

/** What each `board.*` method does (see board-api.ts): you act as yourself. */

type BoardMethod = Extract<Method, `board.${string}`>;
type BoardHandlers = { readonly [M in BoardMethod]: (s: Session, ...args: Args<M>) => unknown };

/**
 * A task can be for you, your Claude or a teammate, never a teammate's Claude (BLG-262): you ask
 * their Claude in a chat with them, where they see it and answer it. Unchanged is fine (a task
 * given before keeps saying so until someone changes it).
 */
const selfOf = (me: Assignee): string => (me.kind === 'person' ? me.id : me.owner);

export function ownClaudeOnly(assignee: Assignee | null | undefined, self: string, was?: Assignee): void {
  if (assignee?.kind !== 'claude' || assignee.owner === self) return;
  if (was?.kind === 'claude' && was.owner === assignee.owner) return;
  throw new Error(`A task can’t be given to ${assignee.ownerName}’s Claude: ask it in a chat with ${assignee.ownerName} (type @ to mention the task)`);
}

export const BOARD_HANDLERS = {
  'board.create': (s, input) => {
    const work = needBoard(s);
    ownClaudeOnly(input.assignee, selfOf(work.me()));
    const { goal, describe, title, ...rest } = input;
    if (!title?.trim() && describe) return work.createDescribed(rest, describe);
    return work.board.create({ ...rest, title: title ?? '', ...(goal?.trim() ? { brief: { goal } } : {}) }, work.me());
  },
  'board.update': (s, ref, patch) => {
    const work = needBoard(s);
    ownClaudeOnly(patch.assignee, selfOf(work.me()), work.board.get(ref)?.assignee);
    return work.board.update(ref, patch, work.me());
  },
  'board.move': (s, ref, status, between) => {
    const work = needBoard(s);
    return work.board.move(ref, status, between ?? {}, work.me());
  },
  'board.editBrief': (s, ref, section, text, reason) => {
    const work = needBoard(s);
    return work.board.editBrief(ref, section, text, work.me(), reason ? { reason } : {});
  },
  'board.restoreRevision': (s, ref, revision) => {
    const work = needBoard(s);
    return work.board.restoreRevision(ref, revision, work.me());
  },
  'board.comment': (s, ref, text) => {
    const work = needBoard(s);
    return work.board.comment(ref, text, work.me());
  },
  'board.relate': (s, ref, relation, other, on) => {
    const work = needBoard(s);
    return work.board.relate(ref, relation, other, on, work.me());
  },
  'board.addProof': (s, ref, proof) => {
    const work = needBoard(s);
    if (proof.path && isSecretPath(proof.path)) throw new Error('That file holds secrets: it can’t be attached');
    return work.board.addProof(ref, proof, work.me());
  },
  'board.removeProof': (s, ref, proofId) => {
    const work = needBoard(s);
    return work.board.removeProof(ref, proofId, work.me());
  },
  'board.remove': (s, ref) => needBoard(s).board.remove(ref),
  'board.start': (s, ref, opts) => needBoard(s).start(ref, opts ?? {}),
  'board.archive': (s, ref) => {
    const work = needBoard(s);
    return work.board.archive(ref, work.me());
  },
  'board.archiveDone': (s, projectId) => {
    const work = needBoard(s);
    return work.board.archiveDone(work.me(), projectId);
  },
  'board.unarchive': (s, ref) => {
    const work = needBoard(s);
    return work.board.unarchive(ref, work.me());
  },
  'board.emptyArchive': (s, projectId) => needBoard(s).board.emptyArchive(projectId),
  'board.settleGone': (s, ref, next) => {
    const work = needBoard(s);
    return work.board.settleGone(ref, next, work.me());
  },
  'board.setAutoTasks': (s, on) => needBoard(s).board.setAutoTasks(on),
  'board.setPrefix': (s, projectId, prefix) => needBoard(s).board.setPrefix(projectId, prefix),
  'board.syncTeams': (s, provider, key) => answer(() => syncOf(s).teams(provider, key)),
  'board.syncConnect': (s, projectId, input) => answer(() => syncOf(s).connect(projectId, input)),
  'board.syncDisconnect': (s, projectId) => syncOf(s).disconnect(projectId),
  'board.syncNow': async (s, projectId) => void (await syncOf(s).sync(projectId)),
  'board.syncAuto': (s, projectId, on) => syncOf(s).setAuto(projectId, on),
} satisfies BoardHandlers;

/** `{ ok: true, … }`, or `{ ok: false, error }` when a key or team won't do (the sheet says why, by the field). */
async function answer<T extends object>(fn: () => Promise<T>): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
