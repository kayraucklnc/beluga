import { useSyncExternalStore } from 'react';
import type { Location } from '../../../../../src/core/store.js';

/**
 * Files you're editing, by where they are. A file opens read-only; Edit starts a session here (the
 * text you started from and your draft), so the panel's preview and the full-size view share it and
 * moving between them, or to another file and back, keeps what you typed. Saving goes through the
 * daemon (files.save), which refuses when the file changed since you started.
 */

export interface EditSession {
  readonly key: string;
  readonly wsId: string;
  readonly path: string;
  /** The text you started from (line breaks as \n), and its hash as the daemon sees the file. */
  readonly base: string;
  readonly baseHash: Promise<string>;
  /** The file used \r\n: saved that way again (a text box only knows \n). */
  readonly crlf: boolean;
  readonly draft: string;
  readonly busy?: 'saving' | 'formatting';
  readonly error?: string;
  /** It changed on disk since you started; Save Anyway overwrites it. */
  readonly conflict?: boolean;
}

export const editKey = (at: Pick<Location, 'owner' | 'share' | 'path'>): string => `${at.owner}\0${at.share}\0${at.path}`;

const sessions = new Map<string, EditSession>();
const listeners = new Set<() => void>();
let version = 0;

const emit = (): void => {
  version++;
  for (const l of listeners) l();
};

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The edit session for this file (re-renders when it changes), or undefined while it's read-only. */
export function useEditSession(at: Pick<Location, 'owner' | 'share' | 'path'> | undefined): EditSession | undefined {
  useSyncExternalStore(subscribe, () => version);
  return at ? sessions.get(editKey(at)) : undefined;
}

export const editSession = (at: Pick<Location, 'owner' | 'share' | 'path'>): EditSession | undefined => sessions.get(editKey(at));

/** Whether you've typed something not saved yet. */
export const isDirty = (e: EditSession | undefined): boolean => Boolean(e && e.draft !== e.base);

/** Files with edits not saved yet. */
export const dirtyPaths = (): string[] => [...sessions.values()].filter(isDirty).map((e) => e.path);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

/** Start editing the file as it is now. */
export function startEditing(at: Location, wsId: string, content: string, draft?: string): EditSession {
  const base = lf(content);
  const session: EditSession = { key: editKey(at), wsId, path: at.path, base, baseHash: sha256(content), crlf: content.includes('\r\n'), draft: draft !== undefined ? lf(draft) : base };
  sessions.set(session.key, session);
  emit();
  return session;
}

export function updateSession(key: string, patch: Partial<Omit<EditSession, 'key' | 'wsId' | 'path'>>): void {
  const now = sessions.get(key);
  if (!now) return;
  const next: EditSession = { ...now, ...patch };
  // Typing clears the last error (and the conflict, once you've seen it).
  if (patch.draft !== undefined && patch.error === undefined) delete (next as { error?: string }).error;
  sessions.set(key, next);
  emit();
}

export const setDraft = (key: string, draft: string): void => updateSession(key, { draft: lf(draft) });

/** Back to read-only (what you typed and didn't save is gone). */
export function stopEditing(key: string): void {
  if (sessions.delete(key)) emit();
}

/** The draft as it's written to disk (with the file's own line breaks). */
export const textToSave = (e: EditSession): string => (e.crlf ? e.draft.replace(/\n/g, '\r\n') : e.draft);

/** Saved: what's on disk now is where the next edit starts from. */
export function markSaved(key: string, saved: string, hash: string): void {
  const now = sessions.get(key);
  if (!now) return;
  const rest: EditSession = { ...now, base: lf(saved), baseHash: Promise.resolve(hash) };
  delete (rest as { busy?: string }).busy;
  delete (rest as { error?: string }).error;
  delete (rest as { conflict?: boolean }).conflict;
  sessions.set(key, rest);
  emit();
}
