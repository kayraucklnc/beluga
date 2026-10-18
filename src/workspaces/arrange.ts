import type { ProjectGroup } from './types.js';

/**
 * How your projects are arranged in the sidebar, Finder-style: the top level mixes loose
 * projects and groups in the order you put them, and each group keeps its projects in order.
 *
 * Kept in projects.json as `order` (top-level keys: a project's root, or `group:<name>`) and
 * each group's `projects` array. Until you arrange anything there is no `order`: loose
 * projects show alphabetically, then the groups, each group's projects alphabetically (as
 * before). Browser-safe: no Node imports.
 */

export const GROUP_PREFIX = 'group:';
export const groupKey = (name: string): string => `${GROUP_PREFIX}${name}`;
export const isGroupKey = (key: string): boolean => key.startsWith(GROUP_PREFIX);
export const groupOfKey = (key: string): string => key.slice(GROUP_PREFIX.length);
export const MAX_GROUP_NAME = 30;

export interface Layout {
  /** Top-level keys in the order you put them; undefined until you arrange something. */
  readonly order?: readonly string[];
  readonly groups: readonly ProjectGroup[];
}

/** What moves (or where it goes before): a project by its root, or a group by its name. */
export type Item = { readonly project: string } | { readonly group: string };

export interface Place {
  /** Into this group; null or missing: the top level. */
  readonly into?: string | null;
  /** Before this item (in the same place); null or missing: at the end. */
  readonly before?: Item | null;
}

export class ArrangeError extends Error {}

export const keyOf = (item: Item): string => ('project' in item ? item.project : groupKey(item.group));

const looseRoots = (groups: readonly ProjectGroup[], roots: readonly string[]): string[] => {
  const grouped = new Set(groups.flatMap((g) => g.projects));
  return roots.filter((r) => !grouped.has(r));
};

/** A group's projects in the order they show in `roots` (the alphabetical list); others after. */
const byRoots = (list: readonly string[], roots: readonly string[]): string[] => {
  const at = new Map(roots.map((r, i) => [r, i]));
  return [...list].sort((a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity));
};

/** Every group's projects as they show: kept as is once arranged, alphabetical before. */
export function shownGroups(layout: Layout, roots: readonly string[]): ProjectGroup[] {
  return layout.groups.map((g) => (layout.order ? g : { ...g, projects: byRoots(g.projects, roots) }));
}

/**
 * The top level as it shows: the saved order (what still exists), then what isn't in it yet
 * (loose projects alphabetically, then groups in the order they were made).
 */
export function topLevel(layout: Layout, roots: readonly string[]): string[] {
  const all = [...looseRoots(layout.groups, roots), ...layout.groups.map((g) => groupKey(g.name))];
  const exists = new Set(all);
  const saved = [...new Set(layout.order ?? [])].filter((k) => exists.has(k));
  const placed = new Set(saved);
  return [...saved, ...all.filter((k) => !placed.has(k))];
}

/**
 * The saved order made complete: everything at the top level, plus the keys of projects you hid
 * (`retain`), so one shown again comes back where it was.
 */
function fullOrder(layout: Layout, roots: readonly string[], retain: ReadonlySet<string>): string[] {
  const live = new Set(topLevel(layout, roots));
  const saved = [...new Set(layout.order ?? [])].filter((k) => live.has(k) || retain.has(k));
  const placed = new Set(saved);
  return [...saved, ...topLevel(layout, roots).filter((k) => !placed.has(k))];
}

/** The layout pinned down as it shows now (what any arranging starts from). */
export function settle(layout: Layout, roots: readonly string[], retain: ReadonlySet<string> = new Set()): Required<Layout> {
  return { order: fullOrder(layout, roots, retain), groups: shownGroups(layout, roots) };
}

const insert = <T>(list: readonly T[], value: T, at: number): T[] => [...list.slice(0, at), value, ...list.slice(at)];

/**
 * Move a project (into a group, or to the top level) or a group (among the top level), before
 * another item or at the end. `roots` are the projects that show, alphabetically; `retain` the
 * hidden ones whose place is kept. Throws ArrangeError for anything that isn't there.
 */
export function move(layout: Layout, roots: readonly string[], item: Item, place: Place, retain: ReadonlySet<string> = new Set()): Required<Layout> {
  const start = settle(layout, roots, retain);
  const into = place.into ?? null;
  const before = place.before ?? null;
  if ('project' in item) {
    if (!roots.includes(item.project)) throw new ArrangeError('That project isn’t in the list');
  } else {
    if (!start.groups.some((g) => g.name === item.group)) throw new ArrangeError(`No group called "${item.group}"`);
    if (into !== null) throw new ArrangeError('A group can’t go inside another group');
  }
  if (into !== null && !start.groups.some((g) => g.name === into)) throw new ArrangeError(`No group called "${into}"`);
  const key = keyOf(item);
  // Taken out of where it is…
  const groups = 'project' in item ? start.groups.map((g) => ({ ...g, projects: g.projects.filter((r) => r !== key) })) : start.groups;
  const order = start.order.filter((k) => k !== key);
  // …and put in its new place (before itself: where it was).
  if (before && keyOf(before) === key) {
    if (into === null ? !start.order.includes(key) : !start.groups.find((g) => g.name === into)!.projects.includes(key)) throw new ArrangeError('It can’t go there');
    return start;
  }
  if (into !== null) {
    const target = groups.find((g) => g.name === into)!;
    const at = before ? ('project' in before ? target.projects.indexOf(before.project) : -1) : target.projects.length;
    if (at < 0) throw new ArrangeError(`That isn’t in "${into}"`);
    return { order, groups: groups.map((g) => (g === target ? { ...g, projects: insert(g.projects, key, at) } : g)) };
  }
  const live = new Set(topLevel({ order, groups }, roots));
  const at = before ? (live.has(keyOf(before)) ? order.indexOf(keyOf(before)) : -1) : order.length;
  if (at < 0) throw new ArrangeError('It can’t go there');
  return { order: insert(order, key, at), groups };
}

/** Projects with a root, in the order they show (top level, each group's in place). */
export function arrangedOrder<P extends { readonly root: string }>(layout: Layout, projects: readonly P[]): { projects: P[]; groups: ProjectGroup[]; order: string[] } {
  const roots = projects.map((p) => p.root);
  const order = topLevel(layout, roots);
  const groups = shownGroups(layout, roots);
  if (!layout.order) return { projects: [...projects], groups, order };
  const byRoot = new Map(projects.map((p) => [p.root, p]));
  const byName = new Map(groups.map((g) => [g.name, g]));
  const flat = order.flatMap((k) => (isGroupKey(k) ? (byName.get(groupOfKey(k))?.projects ?? []) : [k]));
  const listed = [...new Set(flat)].flatMap((r) => byRoot.get(r) ?? []);
  const seen = new Set(listed);
  return {
    projects: [...listed, ...projects.filter((p) => !seen.has(p))],
    groups: order.filter(isGroupKey).flatMap((k) => byName.get(groupOfKey(k)) ?? []),
    order,
  };
}
