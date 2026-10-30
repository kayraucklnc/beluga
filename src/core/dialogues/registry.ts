import type { Dialogues } from './service.js';

/** Which dialogues serve a session (the daemon's), so the composer and the API reach them. */
const all = new WeakMap<object, Dialogues>();

export const attachDialogues = (session: object, dialogues: Dialogues): void => void all.set(session, dialogues);
export const detachDialogues = (session: object): void => void all.delete(session);
export const dialoguesOf = (session: object): Dialogues | undefined => all.get(session);

/** The session's dialogues, or a clear error where there are none (the terminal on its own). */
export function needDialogues(session: object): Dialogues {
  const d = all.get(session);
  if (!d) throw new Error('Dialogues need the Beluga app (its daemon): they are not available here.');
  return d;
}
