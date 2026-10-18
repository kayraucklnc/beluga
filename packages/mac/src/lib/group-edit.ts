import { useSyncExternalStore } from 'react';
import { getPrefs, setPrefs } from './prefs.js';

/**
 * Editing project groups in the sidebar, Finder-style: a new group row with its name field
 * (and the project that moves into it), a group being renamed in place, a project being dragged.
 */
export interface GroupEdit {
  /** A new group's row is showing, with its name field; Return makes it and moves this project in. */
  readonly creating?: { readonly projectId: string };
  /** This group's name is a field. */
  readonly renaming?: string;
  /** The project being dragged (to a group, or out of one). */
  readonly dragging?: string;
}

type Listener = () => void;
let current: GroupEdit = {};
const listeners = new Set<Listener>();

export function editGroups(patch: Partial<GroupEdit>): void {
  current = { ...current, ...patch };
  for (const l of [...listeners]) l();
}

/** Start a new group for a project: the sidebar shows its row with the name field focused. */
export function newGroupFor(projectId: string): void {
  // The row shows in the sidebar's Projects: make sure you can see it.
  const prefs = getPrefs();
  if (!prefs.sidebar || prefs.folded.includes('projects')) setPrefs({ sidebar: true, folded: prefs.folded.filter((f) => f !== 'projects') });
  editGroups({ creating: { projectId }, renaming: undefined });
}

export function useGroupEdit(): GroupEdit {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => current,
  );
}

/** What a dragged project row carries. */
export const PROJECT_DRAG = 'application/x-klaud-project';
