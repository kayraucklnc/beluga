import type { Session } from '../core/session.js';
import { type ContentResults, formatWithPrettier, formatterFor, searchContents, writeWorkspaceFile } from '../core/workspace-files.js';
import type { Args } from './api.js';

/** What each method in files-api.ts does: on your own workspaces' folders, on this Mac. */

type FilesEditMethod = 'files.searchContent' | 'files.save' | 'files.formatter' | 'files.format';
type FilesEditHandlers = { readonly [M in FilesEditMethod]: (s: Session, ...args: Args<M>) => unknown };

/** The workspace's folder, and its project's main folder (where Prettier may be installed instead). */
function foldersOf(s: Session, wsId: string): { root: string; more: string[] } {
  const ws = s.workspaces?.manager.find(wsId);
  if (!ws?.path || ws.archived) throw new Error('That workspace isn’t on this Mac');
  return { root: ws.path, more: ws.projectRoot && ws.projectRoot !== ws.path ? [ws.projectRoot] : [] };
}

/** Searches running now, by session and slot: a newer one in the same slot stops the older. */
const running = new WeakMap<Session, Map<string, AbortController>>();

export const FILES_EDIT_HANDLERS = {
  'files.searchContent': async (s, wsId, query, opts): Promise<ContentResults> => {
    const { root } = foldersOf(s, wsId);
    const slots = running.get(s) ?? new Map<string, AbortController>();
    running.set(s, slots);
    const slot = `${wsId}\0${opts?.slot ?? ''}`;
    slots.get(slot)?.abort();
    const ctl = new AbortController();
    slots.set(slot, ctl);
    try {
      return await searchContents(root, query, { regex: opts?.regex ?? false, caseSensitive: opts?.caseSensitive ?? false, wholeWord: opts?.wholeWord ?? false }, ctl.signal);
    } finally {
      if (slots.get(slot) === ctl) slots.delete(slot);
    }
  },
  'files.save': (s, wsId, rel, content, opts) => writeWorkspaceFile(foldersOf(s, wsId).root, rel, content, opts ?? {}),
  'files.formatter': (s, wsId, rel) => {
    const { root, more } = foldersOf(s, wsId);
    return formatterFor(root, rel, more);
  },
  'files.format': (s, wsId, rel, content) => {
    const { root, more } = foldersOf(s, wsId);
    return formatWithPrettier(root, rel, content, more);
  },
} satisfies FilesEditHandlers;
