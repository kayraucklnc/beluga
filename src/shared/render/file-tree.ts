/**
 * A file tree Claude wrote as text (`tree`'s output, or by hand with ├── └── │), read as folders
 * and files so the screens can draw it as a tree that folds. Only box-drawing trees count (and
 * `|--` / `` `-- `` / `+---` / `\---`): an indented list could as well be YAML. Pure: the Mac and
 * the phone draw from the same reading.
 */

export interface TreeNode {
  readonly name: string;
  /** What Claude wrote after it ("# entry point", "← new"). */
  readonly note?: string;
  readonly dir: boolean;
  /** "…" or "..." in place of more entries. */
  readonly more?: boolean;
  readonly children: readonly TreeNode[];
}

export interface FileTree {
  readonly roots: readonly TreeNode[];
  /** `tree`'s last line ("3 directories, 12 files"). */
  readonly summary?: string;
  readonly dirs: number;
  readonly files: number;
}

const BRANCH = /^([\s│┃|]*?)(├──|└──|├─|└─|┣━━|┗━━|┣━|┗━|\|--|\|──|`--|`──|\+---|\\---|\+--|\\--)[-─━]*\s?(.*)$/;
const SUMMARY = /^\s*\d+ director(?:y|ies)(?:, \d+ files?)?\s*$/;
// A note after a name: two spaces or more, or a marker (#, //, ←, <-, —).
const NOTE = /^(.*?)(?:\s+(?:#|\/\/|←|<-+|—|–)\s*(.*)|\s{2,}(\S.*))$/;
const ONLY_RAILS = /^[\s│┃|]*$/;

const MAX_LINES = 2000;

interface Flat {
  depth: number;
  text: string;
}

function entry(text: string): { name: string; note?: string; more: boolean; slash: boolean } {
  const t = text.trim();
  const m = NOTE.exec(t);
  const name = (m ? m[1]! : t).trim().replace(/^\*\*(.+)\*\*$/, '$1').replace(/^`(.+)`$/, '$1');
  const note = m ? (m[2] ?? m[3])?.trim() : undefined;
  const more = /^(?:\.{3}|…)(?:\s|$)/.test(name) || /^\(.*more.*\)$/i.test(name);
  return { name, ...(note ? { note } : {}), more, slash: /[/\\]$/.test(name) };
}

/** A tree in the text, or undefined when it isn't one. */
export function readFileTree(text: string): FileTree | undefined {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length > MAX_LINES) return undefined;
  const flat: Flat[] = [];
  let summary: string | undefined;
  let roots = 0;
  let branches = 0;
  let other = 0;
  const cols: number[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || ONLY_RAILS.test(line)) continue;
    if (SUMMARY.test(line)) {
      summary = line.trim();
      continue;
    }
    const b = BRANCH.exec(line);
    if (b) {
      branches++;
      // How deep: by the column its branch starts at, against the columns seen above it.
      const col = [...b[1]!].length;
      while (cols.length && cols.at(-1)! > col) cols.pop();
      if (!cols.length || cols.at(-1)! < col) cols.push(col);
      flat.push({ depth: cols.length - 1 + (roots ? 1 : 0), text: b[3] ?? '' });
      continue;
    }
    // A root ("src/", "."): only before the first branch.
    if (!branches && !/^\s/.test(line) && roots < 1) {
      roots++;
      flat.push({ depth: 0, text: line });
      continue;
    }
    other++;
  }
  if (branches < 2 || other > Math.max(1, branches * 0.15)) return undefined;
  return build(flat, summary);
}

function build(flat: readonly Flat[], summary: string | undefined): FileTree {
  type Mut = { name: string; note?: string; dir: boolean; more?: boolean; children: Mut[] };
  const top: Mut[] = [];
  const stack: { depth: number; node: Mut }[] = [];
  let dirs = 0;
  let files = 0;
  for (const f of flat) {
    const e = entry(f.text);
    const node: Mut = { name: e.slash ? e.name.replace(/[/\\]+$/, '') || e.name : e.name, ...(e.note ? { note: e.note } : {}), dir: e.slash, ...(e.more ? { more: true } : {}), children: [] };
    while (stack.length && stack.at(-1)!.depth >= f.depth) stack.pop();
    const parent = stack.at(-1)?.node;
    if (parent) {
      parent.children.push(node);
      parent.dir = true;
    } else top.push(node);
    stack.push({ depth: f.depth, node });
  }
  const count = (n: Mut): void => {
    if (n.more) return;
    if (n.dir || n.children.length) dirs++;
    else files++;
    n.children.forEach(count);
  };
  top.forEach(count);
  return { roots: top, ...(summary ? { summary } : {}), dirs, files };
}

/** Fences a tree may come in: plain text, or one that says so. */
export const TREE_FENCE = /^(|text|txt|plain|plaintext|tree|filetree|file-tree|files|dir|directory|structure|console|output|sh|bash|shell)$/;

/** A folder's path from the root ("src/lib"), for copying. */
export function nodePath(path: readonly TreeNode[]): string {
  return path
    .map((n) => n.name)
    .filter((n) => n !== '.')
    .join('/');
}
