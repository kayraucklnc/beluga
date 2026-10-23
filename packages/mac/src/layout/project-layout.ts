import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AppState } from '@beluga/core/store.js';
import type { Project } from '@beluga/workspaces/types.js';
import { type Item, type Layout, groupKey, groupOfKey, isGroupKey, move, topLevel } from '@beluga/workspaces/arrange.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';

/**
 * The Projects section as it's arranged: the top level (loose projects and groups, in your
 * order) and each group's projects. A move shows at once (worked out here with the core's own
 * rules) and holds until the daemon's answer arrives, so nothing jumps back for a frame.
 */

/** A project (by id) or a group (by name): what the API arranges. */
export type Target = { readonly project: string } | { readonly group: string };
export interface Place {
  readonly into: string | null;
  readonly before: Target | null;
}

export type Entry = { readonly kind: 'project'; readonly project: Project } | { readonly kind: 'group'; readonly name: string; readonly projects: readonly Project[] };

/** The projects that show, alphabetically (what the core's order falls back on). */
const repos = (projects: readonly Project[]): Project[] => projects.filter((p) => p.root).sort((a, b) => a.name.localeCompare(b.name));

/** The layout the daemon published (made complete here, in case it's from before arranging existed). */
export function publishedLayout(state: Pick<AppState, 'projects' | 'projectGroups' | 'projectOrder'>): Required<Layout> {
  const roots = repos(state.projects).map((p) => p.root);
  return { order: topLevel({ groups: state.projectGroups, ...(state.projectOrder?.length ? { order: state.projectOrder } : {}) }, roots), groups: state.projectGroups };
}

/** The top level, each group with its projects that show (hidden ones aren't listed). */
export function entriesOf(layout: Required<Layout>, projects: readonly Project[]): Entry[] {
  const byRoot = new Map(repos(projects).map((p) => [p.root, p]));
  const groups = new Map(layout.groups.map((g) => [g.name, g]));
  const seen = new Set<string>();
  const entries: Entry[] = layout.order.flatMap((key): Entry[] => {
    if (isGroupKey(key)) {
      const g = groups.get(groupOfKey(key));
      if (!g) return [];
      const list = g.projects.flatMap((r) => byRoot.get(r) ?? []);
      for (const p of list) seen.add(p.root);
      return [{ kind: 'group', name: g.name, projects: list }];
    }
    const p = byRoot.get(key);
    if (!p || seen.has(p.root)) return [];
    seen.add(p.root);
    return [{ kind: 'project', project: p }];
  });
  // Anything the order doesn't mention yet (a project just added) goes last.
  const rest = [...byRoot.values()].filter((p) => !seen.has(p.root)).map((project): Entry => ({ kind: 'project', project }));
  return [...entries, ...rest];
}

export const keyOfEntry = (e: Entry): string => (e.kind === 'group' ? groupKey(e.name) : `project:${e.project.id}`);
export const targetOfEntry = (e: Entry): Target => (e.kind === 'group' ? { group: e.name } : { project: e.project.id });
const sameTarget = (a: Target | null, b: Target | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Where an item is now: its group (or null) and what comes after it there. */
export function placeOf(entries: readonly Entry[], item: Target): Place | undefined {
  const top = entries.findIndex((e) => sameTarget(targetOfEntry(e), item));
  if (top >= 0) return { into: null, before: entries[top + 1] ? targetOfEntry(entries[top + 1]!) : null };
  if (!('project' in item)) return undefined;
  for (const e of entries) {
    if (e.kind !== 'group') continue;
    const i = e.projects.findIndex((p) => p.id === item.project);
    if (i >= 0) return { into: e.name, before: e.projects[i + 1] ? { project: e.projects[i + 1]!.id } : null };
  }
  return undefined;
}

/** Whether moving there would leave it where it is. */
export function staysPut(entries: readonly Entry[], item: Target, place: Place): boolean {
  const now = placeOf(entries, item);
  if (!now) return true;
  return now.into === place.into && (sameTarget(now.before, place.before) || sameTarget(item, place.before));
}

/** Its siblings' targets, in order (the top level, or the group it's in). */
function siblings(entries: readonly Entry[], into: string | null): Target[] {
  if (into === null) return entries.map(targetOfEntry);
  const g = entries.find((e) => e.kind === 'group' && e.name === into);
  return g && g.kind === 'group' ? g.projects.map((p) => ({ project: p.id })) : [];
}

/** One step up (-1) or down (+1) among its siblings; undefined at the edge. */
export function stepOf(entries: readonly Entry[], item: Target, dir: -1 | 1): Place | undefined {
  const now = placeOf(entries, item);
  if (!now) return undefined;
  const list = siblings(entries, now.into);
  const at = list.findIndex((t) => sameTarget(t, item));
  if (dir < 0) return at > 0 ? { into: now.into, before: list[at - 1]! } : undefined;
  if (at < 0 || at >= list.length - 1) return undefined;
  return { into: now.into, before: list[at + 2] ?? null };
}

/** Out of its group, onto the top level right after that group. */
export function outOfGroup(entries: readonly Entry[], group: string): Place {
  const at = entries.findIndex((e) => e.kind === 'group' && e.name === group);
  const next = at >= 0 ? entries[at + 1] : undefined;
  return { into: null, before: next ? targetOfEntry(next) : null };
}

// ---------------------------------------------------------------- the move that's on its way

let pending: Required<Layout> | undefined;
const listeners = new Set<() => void>();
const setPending = (next: Required<Layout> | undefined): void => {
  pending = next;
  for (const l of [...listeners]) l();
};

/** The layout to draw: the one on its way, else the published one. */
export function useLayout(): { layout: Required<Layout>; entries: Entry[] } {
  const projects = useApp((st) => st.projects);
  const groups = useApp((st) => st.projectGroups);
  const order = useApp((st) => st.projectOrder);
  const local = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => pending,
  );
  // The daemon answered (or something else changed them): draw what it says.
  useEffect(() => setPending(undefined), [projects, groups, order]);
  // The same entries until something in them changes (each project's block is memo'd on them).
  return useMemo(() => {
    const layout = local ?? publishedLayout({ projects, projectGroups: groups, projectOrder: order });
    return { layout, entries: entriesOf(layout, projects) };
  }, [local, projects, groups, order]);
}

/** Arrange the sidebar: shows at once, then asks the daemon (which has the last word). */
export function useArrange(): (item: Target, place: Place) => void {
  const api = useApi();
  const { client } = useBeluga();
  return useCallback((item, place) => {
    const state = client.store.getState();
    const layout = pending ?? publishedLayout(state);
    const rootOf = (t: Target): Item => ('project' in t ? { project: state.projects.find((p) => p.id === t.project)?.root ?? '' } : t);
    try {
      setPending(move(layout, repos(state.projects).map((p) => p.root), rootOf(item), { into: place.into, before: place.before ? rootOf(place.before) : null }, new Set(state.hiddenProjects)));
    } catch {
      // The daemon says why (a toast).
    }
    void api.workspaces.arrange(item, place).then(
      (ok) => (ok ? undefined : setPending(undefined)),
      () => setPending(undefined),
    );
  }, [api, client]);
}

