import { useSyncExternalStore } from 'react';
import { getPrefs, setPrefs } from './prefs.js';

/**
 * Editing project groups in the sidebar, Finder-style: a new group row with its name field
 * (and the project that moves into it, if any), a group being renamed in place.
 */
export interface GroupEdit {
  /** A new group's row is showing, with its name field; Return makes it (moving this project in, if any). */
  readonly creating?: { readonly projectId?: string };
  /** This group's name is a field. */
  readonly renaming?: string;
}

type Listener = () => void;
let current: GroupEdit = {};
const listeners = new Set<Listener>();

export function editGroups(patch: Partial<GroupEdit>): void {
  current = { ...current, ...patch };
  for (const l of [...listeners]) l();
}

/** Make sure the sidebar's Projects show (where the name field is). */
function revealProjects(): void {
  const prefs = getPrefs();
  if (!prefs.sidebar || prefs.folded.includes('projects')) setPrefs({ sidebar: true, folded: prefs.folded.filter((f) => f !== 'projects') });
}

/** Start a new group for a project: its row shows where the project is, with the name field focused. */
export function newGroupFor(projectId: string): void {
  revealProjects();
  editGroups({ creating: { projectId }, renaming: undefined });
}

/** Start a new, empty group: its row shows at the end of the projects, with the name field focused. */
export function newEmptyGroup(): void {
  revealProjects();
  editGroups({ creating: {}, renaming: undefined });
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
