/**
 * The Files tab's tree, as plain data: the rows you see for the folders you've opened (or, while
 * filtering, every name that matches in the folders loaded so far), and which folders to load
 * next when filtering. No React here, so it's tested on its own.
 */

export interface Entry {
  readonly name: string;
  readonly dir: boolean;
  readonly size?: number;
}

export type TreeRow =
  | { readonly kind: 'entry'; readonly path: string; readonly name: string; readonly dir: boolean; readonly open: boolean; readonly depth: number; readonly size?: number }
  | { readonly kind: 'loading'; readonly path: string; readonly name: string; readonly dir: false; readonly open: false; readonly depth: number; readonly size?: undefined };

type EntriesOf = (path: string) => readonly Entry[] | undefined;

/** Folders that filtering doesn't look into (dependencies, git, build output). */
export const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.turbo', 'vendor', '.venv', 'venv', '__pycache__', 'coverage', '.cache', 'Pods', 'DerivedData']);
/** How deep, and how many folders, filtering loads by itself. */
export const FILTER_DEPTH = 5;
export const FILTER_FOLDERS = 150;

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** "a/b/c.ts" → ["a", "a/b"]. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * The rows to show. Without a filter: each opened folder's contents under it (a "Loading…" row
 * while a folder is on its way). With one: the names containing it, with the folders above
 * them, in every folder loaded so far.
 */
export function treeRows(entriesOf: EntriesOf, expanded: ReadonlySet<string>, query: string): TreeRow[] {
  const all = query.trim().toLowerCase();
  const out: TreeRow[] = [];
  // `q`: the filter ('' inside a matching folder you opened: all of it shows).
  const walk = (dir: string, depth: number, q: string = all): boolean => {
    const list = entriesOf(dir);
    if (!list) {
      if (!q) out.push({ kind: 'loading', path: dir, name: '', dir: false, open: false, depth });
      return false;
    }
    let found = false;
    for (const e of list) {
      const path = join(dir, e.name);
      const hit = q !== '' && e.name.toLowerCase().includes(q);
      if (!q) {
        const open = e.dir && expanded.has(path);
        out.push({ kind: 'entry', path, name: e.name, dir: e.dir, open, depth, ...(e.size !== undefined && !e.dir ? { size: e.size } : {}) });
        if (open) walk(path, depth + 1);
        continue;
      }
      if (!e.dir) {
        if (hit) {
          out.push({ kind: 'entry', path, name: e.name, dir: false, open: false, depth, ...(e.size !== undefined ? { size: e.size } : {}) });
          found = true;
        }
        continue;
      }
      // A folder shows when its name matches or something inside it does.
      const at = out.length;
      out.push({ kind: 'entry', path, name: e.name, dir: true, open: true, depth });
      const inside = SKIP.has(e.name) ? false : walk(path, depth + 1);
      if (inside || hit) found = true;
      else out.length = at;
      if (hit && !inside) {
        // A folder whose name matches: closed, unless you open it (then everything in it shows).
        const open = expanded.has(path);
        out[at] = { kind: 'entry', path, name: e.name, dir: true, open, depth };
        if (open) walk(path, depth + 1, '');
      }
    }
    return found;
  };
  walk('', 0);
  return out;
}

/** While filtering: the folders to load next (not yet asked for, not too deep, not dependencies). */
export function filterLoads(entriesOf: EntriesOf, requested: ReadonlySet<string>): string[] {
  const want: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
  while (queue.length && requested.size + want.length < FILTER_FOLDERS) {
    const { path, depth } = queue.shift()!;
    const list = entriesOf(path);
    if (!list) {
      if (!requested.has(path)) want.push(path);
      continue;
    }
    if (depth >= FILTER_DEPTH) continue;
    for (const e of list) if (e.dir && !SKIP.has(e.name) && !e.name.startsWith('.')) queue.push({ path: join(path, e.name), depth: depth + 1 });
  }
  return want;
}
