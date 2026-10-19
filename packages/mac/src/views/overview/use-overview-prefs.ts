import { useCallback, useEffect, useState } from 'react';
import { type OverviewPrefs, readOverviewPrefs } from './overview-model.js';

const KEY = 'klaud.overview.v1';

function load(): OverviewPrefs {
  try {
    return readOverviewPrefs(localStorage.getItem(KEY));
  } catch {
    return readOverviewPrefs(null);
  }
}

const CHANGED = 'klaud:overview-prefs';

/**
 * Set the Overview's segment and project from elsewhere (a project's "Show Archived"): kept like
 * the Overview keeps them, and an Overview already open follows.
 */
export function setOverviewView(patch: { readonly filter?: OverviewPrefs['filter']; readonly project?: string }): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...load(), ...patch }));
  } catch {
    // No storage: the Overview opens as you left it.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/** A change: `project: undefined` goes back to all projects. */
export type OverviewPrefsPatch = { readonly [K in keyof OverviewPrefs]?: OverviewPrefs[K] | undefined };

/** The Overview's segment, sort and project, kept on this Mac between visits. */
export function useOverviewPrefs(): [OverviewPrefs, (patch: OverviewPrefsPatch) => void] {
  const [prefs, setPrefs] = useState(load);
  useEffect(() => {
    const follow = (): void => setPrefs(load());
    window.addEventListener(CHANGED, follow);
    return () => window.removeEventListener(CHANGED, follow);
  }, []);
  const update = useCallback((patch: OverviewPrefsPatch) => {
    setPrefs((current) => {
      const filter = patch.filter ?? current.filter;
      const sort = patch.sort ?? current.sort;
      const project = 'project' in patch ? patch.project : current.project;
      // "All projects" is no project at all, not an empty id.
      const next: OverviewPrefs = project ? { filter, sort, project } : { filter, sort };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private browsing or a full disk: the choice still holds for this visit.
      }
      return next;
    });
  }, []);
  return [prefs, update];
}
