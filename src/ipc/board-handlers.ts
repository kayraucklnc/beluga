import { isSecretPath } from '../core/shares.js';
import { needBoard } from '../core/board/registry.js';
import { syncOf } from '../core/board/sync/sync.js';
import { canAssign } from '../core/team/model.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** A project's task is for you or a teammate on it, never any friend (BLG-299). */
function onTeam(s: Session, projectId: string, assignee: { readonly id: string; readonly name: string } | undefined): void {
  const state = s.store.getState();
  if (!canAssign(state.team, projectId, state.selfId, assignee?.id)) throw new Error(`${assignee!.name} isn’t on this project’s team. Team up with them first to give them its tasks`);
}

/** What each `board.*` method does (see board-api.ts): you act as yourself. */

type BoardMethod = Extract<Method, `board.${string}`>;
type BoardHandlers = { readonly [M in BoardMethod]: (s: Session, ...args: Args<M>) => unknown };

export const BOARD_HANDLERS = {
  'board.create': (s, input) => {
    const work = needBoard(s);
    onTeam(s, input.projectId, input.assignee);
    const { goal, describe, title, ...rest } = input;
    // New Task's words may ask for several tasks and say who each is for (BLG-319).
    if (!title?.trim() && describe) return work.createDescribed(rest, describe, { several: true });
    return work.board.create({ ...rest, title: title ?? '', ...(goal?.trim() ? { brief: { goal } } : {}) }, work.me());
  },
  'board.update': (s, ref, patch) => {
    const work = needBoard(s);
    const issue = work.board.get(ref);
    // Keeping who it's already for is fine (a task given before BLG-299); a new someone must be on the team.
    if (issue && patch.assignee && patch.assignee.id !== issue.assignee?.id) onTeam(s, issue.projectId, patch.assignee);
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
  'board.createLabel': (s, projectId, label) => needBoard(s).board.createLabel(projectId, label),
  'board.removeLabel': (s, projectId, name) => needBoard(s).board.removeLabel(projectId, name),
  'board.setContext': (s, projectId, text) => {
    const work = needBoard(s);
    work.board.setContext(projectId, text, work.me().name);
  },
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
