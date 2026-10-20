import type { BoardWork } from './work.js';

/** Which board serves a session (the daemon's), so the API and Claude's runs can reach it. */
const boards = new WeakMap<object, BoardWork>();

export const attachBoard = (session: object, board: BoardWork): void => void boards.set(session, board);
export const detachBoard = (session: object): void => void boards.delete(session);
export const boardOf = (session: object): BoardWork | undefined => boards.get(session);

/** The session's board, or a clear error where there is none (the terminal on its own). */
export function needBoard(session: object): BoardWork {
  const board = boards.get(session);
  if (!board) throw new Error('Tasks need the Klaud app (its daemon): they are not available here.');
  return board;
}
