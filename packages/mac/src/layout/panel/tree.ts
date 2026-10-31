/**
 * The Files tab's tree, as plain data: the rows you see for the folders you've opened, and the
 * files a name search found, laid out as a tree. No React here, so it's tested on its own.
 */

export interface Entry {
  readonly name: string;
  readonly dir: boolean;
  readonly size?: number;
}

export type TreeRow =
  | { readonly kind: 'entry'; readonly path: string; readonly name: string; readonly dir: boolean; readonly open: boolean; readonly depth: number; readonly size?: number; readonly marks?: ReadonlyArray<readonly [number, number]> }
  | { readonly kind: 'loading'; readonly path: string; readonly name: string; readonly dir: false; readonly open: false; readonly depth: number; readonly size?: undefined; readonly marks?: undefined };

type EntriesOf = (path: string) => readonly Entry[] | undefined;

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** "a/b/c.ts" → ["a", "a/b"]. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** The rows to show: each opened folder's contents under it (a "Loading…" row while a folder is on its way). */
export function treeRows(entriesOf: EntriesOf, expanded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const list = entriesOf(dir);
    if (!list) return void out.push({ kind: 'loading', path: dir, name: '', dir: false, open: false, depth });
    for (const e of list) {
      const path = join(dir, e.name);
      const open = e.dir && expanded.has(path);
      out.push({ kind: 'entry', path, name: e.name, dir: e.dir, open, depth, ...(e.size !== undefined && !e.dir ? { size: e.size } : {}) });
      if (open) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** A file the name search found: its path, and where the query matched in it. */
export interface Found {
  readonly path: string;
  readonly ranges: ReadonlyArray<readonly [number, number]>;
}

/** Where the matches fall in a path's last part (its name), as offsets into that name. */
export function nameRanges(path: string, ranges: Found['ranges']): Array<[number, number]> {
  const start = path.lastIndexOf('/') + 1;
  return ranges.filter(([, b]) => b > start).map(([a, b]) => [Math.max(0, a - start), b - start]);
}

/**
 * The files a name search found, as a tree: each one under its folders, every folder open,
 * folders before files and both by name (the way the folder tree lists them).
 */
export function foundRows(found: readonly Found[]): TreeRow[] {
  interface Node {
    dirs: Map<string, Node>;
    files: Found[];
  }
  const top: Node = { dirs: new Map(), files: [] };
  for (const f of found) {
    let at = top;
    for (const part of f.path.split('/').slice(0, -1)) {
      let next = at.dirs.get(part);
      if (!next) at.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      at = next;
    }
    at.files.push(f);
  }
  const out: TreeRow[] = [];
  const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const walk = (node: Node, dir: string, depth: number): void => {
    for (const name of [...node.dirs.keys()].sort(byName)) {
      const path = join(dir, name);
      out.push({ kind: 'entry', path, name, dir: true, open: true, depth });
      walk(node.dirs.get(name)!, path, depth + 1);
    }
    for (const f of [...node.files].sort((a, b) => byName(a.path, b.path))) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      out.push({ kind: 'entry', path: f.path, name, dir: false, open: false, depth, marks: nameRanges(f.path, f.ranges) });
    }
  };
  walk(top, '', 0);
  return out;
}
