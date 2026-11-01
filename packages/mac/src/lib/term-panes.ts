/**
 * Split panes in the terminal view (BLG-536): the agent's terminal, and shells beside it or under
 * it, as a tree of splits like iTerm2's and Ghostty's. Pure: AgentTermView draws it, and keeps it
 * per conversation (localStorage).
 */

export type PaneTree = { readonly kind: 'pane'; readonly key: string } | { readonly kind: 'split'; readonly dir: 'right' | 'down'; readonly ratio: number; readonly a: PaneTree; readonly b: PaneTree };

/** Panes one view may have (beyond that a split is refused: each is a running program). */
export const MAX_PANES = 6;

export const pane = (key: string): PaneTree => ({ kind: 'pane', key });

/** Every pane's key, left to right, top to bottom. */
export function paneKeys(tree: PaneTree): string[] {
  return tree.kind === 'pane' ? [tree.key] : [...paneKeys(tree.a), ...paneKeys(tree.b)];
}

/** The tree with `target` split in two: the new pane `key` to its right or under it. Unchanged when full or not found. */
export function splitPane(tree: PaneTree, target: string, dir: 'right' | 'down', key: string): PaneTree {
  if (paneKeys(tree).length >= MAX_PANES || paneKeys(tree).includes(key)) return tree;
  const go = (t: PaneTree): PaneTree => {
    if (t.kind === 'pane') return t.key === target ? { kind: 'split', dir, ratio: 0.5, a: t, b: pane(key) } : t;
    const a = go(t.a);
    const b = a === t.a ? go(t.b) : t.b;
    return a === t.a && b === t.b ? t : { ...t, a, b };
  };
  return go(tree);
}

/** The tree without pane `key` (its sibling takes its place); the last pane never goes. */
export function closePane(tree: PaneTree, key: string): PaneTree {
  if (tree.kind === 'pane') return tree;
  if (tree.a.kind === 'pane' && tree.a.key === key) return tree.b;
  if (tree.b.kind === 'pane' && tree.b.key === key) return tree.a;
  const a = closePane(tree.a, key);
  const b = a === tree.a ? closePane(tree.b, key) : tree.b;
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/** The split at `path` ('a'/'b' steps from the root) given a new ratio (kept between 15% and 85%). */
export function resizeSplit(tree: PaneTree, path: string, ratio: number): PaneTree {
  if (tree.kind === 'pane') return tree;
  if (!path) return { ...tree, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  const [step, rest] = [path[0], path.slice(1)];
  return step === 'a' ? { ...tree, a: resizeSplit(tree.a, rest, ratio) } : { ...tree, b: resizeSplit(tree.b, rest, ratio) };
}

/** The lowest free number for a new shell pane, given the keys in use (`<ws>:pane:N`). */
export function nextPaneNumber(keys: readonly string[]): number {
  const used = new Set(keys.map((k) => Number(/:pane:(\d+)$/.exec(k)?.[1] ?? 0)));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** A saved tree, if it's one (and has the agent's pane): anything else is dropped. */
export function treeOf(raw: unknown, agentKey: string): PaneTree | undefined {
  const tree = readTree(raw);
  return tree && paneKeys(tree).includes(agentKey) ? tree : undefined;
}

/** A saved tree, if it's one. */
export function readTree(raw: unknown): PaneTree | undefined {
  const read = (v: unknown, depth: number): PaneTree | undefined => {
    if (!v || typeof v !== 'object' || depth > 8) return undefined;
    const r = v as Record<string, unknown>;
    if (r.kind === 'pane') return typeof r.key === 'string' ? pane(r.key) : undefined;
    if (r.kind !== 'split' || (r.dir !== 'right' && r.dir !== 'down')) return undefined;
    const a = read(r.a, depth + 1);
    const b = read(r.b, depth + 1);
    return a && b ? { kind: 'split', dir: r.dir, ratio: typeof r.ratio === 'number' ? Math.min(0.85, Math.max(0.15, r.ratio)) : 0.5, a, b } : undefined;
  };
  return read(raw, 0);
}

/** One tab of the terminal view: its panes, and the one zoomed to fill it (⇧⌘↩), if any. */
export interface TermTab {
  readonly id: string;
  readonly tree: PaneTree;
  readonly zoom?: string;
}

export interface TermTabs {
  readonly tabs: readonly TermTab[];
  readonly active: string;
}

/** The agent's tab: always first, never closed. */
export const AGENT_TAB = 'agent';

/** Tabs one view may have. */
export const MAX_TABS = 9;

export const firstTabs = (agentKey: string): TermTabs => ({ tabs: [{ id: AGENT_TAB, tree: pane(agentKey) }], active: AGENT_TAB });

/** Every pane's key in every tab. */
export const allPaneKeys = (t: TermTabs): string[] => t.tabs.flatMap((x) => paneKeys(x.tree));

/** A new tab with one pane `key` after the others, and it's the one shown. Unchanged when full. */
export function addTab(t: TermTabs, key: string): TermTabs {
  if (t.tabs.length >= MAX_TABS || allPaneKeys(t).includes(key)) return t;
  const id = `tab:${key}`;
  return { tabs: [...t.tabs, { id, tree: pane(key) }], active: id };
}

/** Without tab `id` (never the agent's): the one before it is shown when it was. */
export function closeTab(t: TermTabs, id: string): TermTabs {
  if (id === AGENT_TAB) return t;
  const at = t.tabs.findIndex((x) => x.id === id);
  if (at < 0) return t;
  const tabs = t.tabs.filter((x) => x.id !== id);
  return { tabs, active: t.active === id ? tabs[Math.max(0, at - 1)]!.id : t.active };
}

/** Tab `id` with its panes changed (a zoom on a pane that went is dropped). */
export function withTree(t: TermTabs, id: string, tree: PaneTree): TermTabs {
  return { ...t, tabs: t.tabs.map((x) => (x.id === id ? { id: x.id, tree, ...(x.zoom && paneKeys(tree).includes(x.zoom) ? { zoom: x.zoom } : {}) } : x)) };
}

/** Tab `id` zoomed on `key`, or back to all its panes. */
export function toggleZoom(t: TermTabs, id: string, key: string): TermTabs {
  return { ...t, tabs: t.tabs.map((x) => (x.id !== id ? x : x.zoom ? { id: x.id, tree: x.tree } : paneKeys(x.tree).length > 1 ? { ...x, zoom: key } : x)) };
}

/** The tab `dir` steps from the shown one (wrapping), or the n-th (1-based; 9 is the last). */
export function stepTab(t: TermTabs, dir: 1 | -1): TermTabs {
  const at = t.tabs.findIndex((x) => x.id === t.active);
  return { ...t, active: t.tabs[(at + dir + t.tabs.length) % t.tabs.length]!.id };
}
export function gotoTab(t: TermTabs, n: number): TermTabs {
  const tab = n >= 9 ? t.tabs[t.tabs.length - 1] : t.tabs[n - 1];
  return tab ? { ...t, active: tab.id } : t;
}

/** The tab a pane is in. */
export const tabOf = (t: TermTabs, key: string): TermTab | undefined => t.tabs.find((x) => paneKeys(x.tree).includes(key));

/** Saved tabs, if they're whole (the agent's tab first, with its pane): else just the agent's. */
export function tabsOf(raw: unknown, agentKey: string): TermTabs {
  const r = raw && typeof raw === 'object' ? (raw as { tabs?: unknown; active?: unknown }) : {};
  const list = Array.isArray(r.tabs) ? r.tabs : [];
  const tabs: TermTab[] = [];
  const seen = new Set<string>();
  for (const x of list.slice(0, MAX_TABS)) {
    const id = x && typeof x === 'object' && typeof (x as TermTab).id === 'string' ? (x as TermTab).id : undefined;
    const tree = id === AGENT_TAB ? treeOf((x as TermTab).tree, agentKey) : readTree((x as TermTab).tree);
    if (!id || !tree || seen.has(id) || paneKeys(tree).some((k) => seen.has(`pane:${k}`))) continue;
    if (id !== AGENT_TAB && paneKeys(tree).includes(agentKey)) continue;
    seen.add(id);
    for (const k of paneKeys(tree)) seen.add(`pane:${k}`);
    tabs.push({ id, tree });
  }
  const agent = tabs.find((x) => x.id === AGENT_TAB);
  const ordered = [agent ?? { id: AGENT_TAB, tree: pane(agentKey) }, ...tabs.filter((x) => x.id !== AGENT_TAB)];
  const active = typeof r.active === 'string' && ordered.some((x) => x.id === r.active) ? r.active : AGENT_TAB;
  return { tabs: ordered, active };
}
