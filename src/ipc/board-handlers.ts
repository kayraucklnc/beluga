import { isSecretPath } from '../core/shares.js';
import { needBoard } from '../core/board/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

/** What each `board.*` method does (see board-api.ts): you act as yourself. */

type BoardMethod = Extract<Method, `board.${string}`>;
type BoardHandlers = { readonly [M in BoardMethod]: (s: Session, ...args: Args<M>) => unknown };

export const BOARD_HANDLERS = {
  'board.create': (s, input) => {
    const work = needBoard(s);
    const { goal, describe, title, ...rest } = input;
    if (!title?.trim() && describe) return work.createDescribed(rest, describe);
    return work.board.create({ ...rest, title: title ?? '', ...(goal?.trim() ? { brief: { goal } } : {}) }, work.me());
  },
  'board.update': (s, ref, patch) => {
    const work = needBoard(s);
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
  'board.settleGone': (s, ref, next) => {
    const work = needBoard(s);
    return work.board.settleGone(ref, next, work.me());
  },
  'board.setAutoTasks': (s, on) => needBoard(s).board.setAutoTasks(on),
  'board.setPrefix': (s, projectId, prefix) => needBoard(s).board.setPrefix(projectId, prefix),
} satisfies BoardHandlers;
