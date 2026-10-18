import type { FsEntry } from '../protocol.js';
import type { SharedWorkspace, ShellLine, ShellState } from './collab-store.js';
import type { SearchHit } from './guest-search.js';
import { dirKey } from './room-files.js';
import { type Location, type Store, clean, peerName } from './store.js';

/**
 * A pretend shell over a workspace someone shared with you. Nothing runs on their computer:
 * each command is a file listing, a file opened in the viewer, or a bounded search they serve.
 */
export const SHELL_COMMANDS: ReadonlyArray<{ name: string; usage: string; about: string }> = [
  { name: 'ls', usage: 'ls [folder]', about: 'list a folder (click a name to open it)' },
  { name: 'cd', usage: 'cd <folder>', about: 'go into a folder (cd .. goes up, cd / to the top)' },
  { name: 'pwd', usage: 'pwd', about: 'where you are' },
  { name: 'cat', usage: 'cat <file>', about: 'open a file in the viewer (also: less, open)' },
  { name: 'tree', usage: 'tree [folder]', about: 'folders and files, a few levels deep' },
  { name: 'find', usage: 'find <name>', about: 'files and folders whose name contains <name>' },
  { name: 'grep', usage: 'grep <text>', about: 'lines containing <text>, in files under here' },
  { name: 'clear', usage: 'clear', about: 'clear the screen' },
  { name: 'help', usage: 'help', about: 'this list' },
];

const MAX_ENTRIES = 200;
const TREE_DEPTH = 3;
const TREE_MAX = 300;

/** Split a command line into words ("quotes" keep spaces). */
export function parseCommand(line: string): { name: string; args: string[] } {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) words.push(m[1] ?? m[2] ?? m[3] ?? '');
  return { name: (words[0] ?? '').toLowerCase(), args: words.slice(1) };
}

/** Resolve a path typed in the shell against the current folder. The top of the share is `/`; you can't go above it. */
export function resolvePath(cwd: string, arg: string | undefined): string {
  const raw = (arg ?? '').trim();
  const fromTop = raw.startsWith('/') || raw === '~' || raw.startsWith('~/');
  const parts = fromTop ? [] : cwd.split('/').filter(Boolean);
  for (const seg of raw.replace(/^~/, '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export const shownPath = (rel: string): string => `/${rel}`;
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** `ls` output: folders first (ending in /), each one clickable. */
export function lsLines(dir: string, entries: readonly FsEntry[]): ShellLine[] {
  if (!entries.length) return [{ text: '(empty)', tone: 'muted' }];
  return [...entries]
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .map((e) => ({ text: e.dir ? `${e.name}/` : e.name, tone: e.dir ? 'dir' : 'file', open: join(dir, e.name), dir: e.dir }));
}

/** `find` / `grep` output, each hit clickable. */
export function hitLines(hits: readonly SearchHit[], truncated: boolean, mode: 'find' | 'grep'): ShellLine[] {
  if (!hits.length) return [{ text: 'nothing found', tone: 'muted' }];
  const lines: ShellLine[] = hits.map((h) =>
    mode === 'grep' ? { text: `${h.path}:${h.line ?? 0}: ${h.text ?? ''}`, tone: 'match', open: h.path, dir: false } : { text: h.path, tone: 'file', open: h.path, dir: false },
  );
  if (truncated) lines.push({ text: '… more results not shown; search a smaller folder', tone: 'muted' });
  return lines;
}

/** Tab completion: shell commands, then names in the folder being typed (from listings already fetched). */
export function completions(buffer: string, cwd: string, listing: (dir: string) => readonly FsEntry[] | undefined): Array<{ label: string; value: string; dir: boolean }> {
  const { name, args } = parseCommand(buffer);
  if (!buffer.includes(' ')) return SHELL_COMMANDS.filter((c) => c.name.startsWith(name) && c.name !== name).map((c) => ({ label: c.name, value: `${c.name} `, dir: false }));
  if (args.length > 1 || buffer.endsWith('  ')) return [];
  const typed = args[0] ?? '';
  const slash = typed.lastIndexOf('/');
  const dirPart = slash >= 0 ? typed.slice(0, slash + 1) : '';
  const prefix = typed.slice(slash + 1).toLowerCase();
  const entries = listing(resolvePath(cwd, dirPart)) ?? [];
  const onlyDirs = name === 'cd' || name === 'tree' || name === 'ls';
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(prefix) && (!onlyDirs || e.dir || name === 'ls'))
    .slice(0, 8)
    .map((e) => ({ label: `${e.name}${e.dir ? '/' : ''}`, value: `${name} ${dirPart}${e.name}${e.dir ? '/' : ''}`, dir: e.dir }));
}

export interface GuestShellDeps {
  readonly store: Store;
  readonly listFiles: (at: Location) => Promise<readonly FsEntry[]>;
  readonly openLocation: (at: Location) => Promise<void>;
  readonly search: (at: Location, mode: 'find' | 'grep', query: string) => Promise<{ hits: readonly SearchHit[]; truncated: boolean }>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs shell commands for one person, one workspace at a time. */
export class GuestShell {
  private seq = 0;

  constructor(private readonly deps: GuestShellDeps) {}

  private shared(id: string): SharedWorkspace | undefined {
    return this.deps.store.getState().shared.find((w) => w.id === id);
  }

  state(id: string): ShellState {
    return this.deps.store.getState().shells[id] ?? { cwd: '', entries: [], busy: false };
  }

  private set(id: string, patch: Partial<ShellState>): void {
    // Names and grep hits come from the owner's files: never let them carry terminal escapes.
    const entries = patch.entries?.map((e) => ({ ...e, out: e.out.map((l) => ({ ...l, text: clean(l.text) })) }));
    this.deps.store.dispatch({ type: 'guest_shell', id, shell: { ...this.state(id), ...patch, ...(entries ? { entries } : {}) } });
  }

  private async list(w: SharedWorkspace, dir: string): Promise<readonly FsEntry[]> {
    const at = { owner: w.owner, share: w.share, path: dir };
    const entries = await this.deps.listFiles(at);
    // Remember it for Tab completion.
    this.deps.store.dispatch({ type: 'dir_cache', key: dirKey(at), entries });
    return entries;
  }

  /** Run one command line and show its output. */
  async run(id: string, line: string): Promise<void> {
    const w = this.shared(id);
    const cmd = line.trim();
    if (!w || !cmd) return;
    const { name, args } = parseCommand(cmd);
    const before = this.state(id);
    if (name === 'clear') return this.set(id, { entries: [] });
    const entry = { id: ++this.seq, cwd: before.cwd, cmd, out: [] as ShellLine[] };
    this.set(id, { entries: [...before.entries, entry].slice(-MAX_ENTRIES), busy: true });
    let out: ShellLine[];
    let cwd = before.cwd;
    try {
      ({ out, cwd } = await this.exec(w, before.cwd, name, args));
    } catch (err) {
      out = [{ text: `${name}: ${errorText(err)}`, tone: 'error' }];
    }
    const latest = this.state(id);
    this.set(id, { cwd, busy: false, entries: latest.entries.map((e) => (e.id === entry.id ? { ...e, out } : e)) });
  }

  private async exec(w: SharedWorkspace, cwd: string, name: string, args: readonly string[]): Promise<{ out: ShellLine[]; cwd: string }> {
    const at = (rel: string): Location => ({ owner: w.owner, share: w.share, path: rel });
    const owner = peerName(this.deps.store.getState(), w.owner);
    switch (name) {
      case 'help':
        return { cwd, out: helpLines(owner, w) };
      case 'pwd':
        return { cwd, out: [{ text: shownPath(cwd) }] };
      case 'ls':
      case 'dir': {
        const dir = resolvePath(cwd, args[0]);
        return { cwd, out: lsLines(dir, await this.list(w, dir)) };
      }
      case 'cd': {
        const dir = resolvePath(cwd, args[0] ?? '/');
        await this.list(w, dir); // fails when it isn't a folder
        return { cwd: dir, out: [] };
      }
      case 'cat':
      case 'less':
      case 'more':
      case 'head':
      case 'open':
      case 'view': {
        if (!args[0]) return { cwd, out: [{ text: `usage: ${name} <file>`, tone: 'error' }] };
        const target = resolvePath(cwd, args[0]);
        void this.deps.openLocation(at(target));
        return { cwd, out: [{ text: `opened ${shownPath(target)} in the viewer →`, tone: 'muted' }] };
      }
      case 'tree':
        return { cwd, out: await this.tree(w, resolvePath(cwd, args[0])) };
      case 'find':
      case 'grep': {
        const query = args.filter((a) => !a.startsWith('-')).join(' ');
        if (!query) return { cwd, out: [{ text: `usage: ${name} <${name === 'find' ? 'name' : 'text'}>`, tone: 'error' }] };
        const res = await this.deps.search(at(cwd), name, query);
        return { cwd, out: hitLines(res.hits, res.truncated, name) };
      }
      default:
        return { cwd, out: [{ text: `${name}: not available here. This is a read-only view of ${owner}'s files: type help`, tone: 'error' }] };
    }
  }

  private async tree(w: SharedWorkspace, root: string): Promise<ShellLine[]> {
    const out: ShellLine[] = [{ text: shownPath(root), tone: 'dir', open: root, dir: true }];
    const walk = async (dir: string, depth: number, indent: string): Promise<void> => {
      const entries = lsLines(dir, await this.list(w, dir)).filter((l) => l.open !== undefined);
      for (const [i, e] of entries.entries()) {
        if (out.length >= TREE_MAX) return;
        const last = i === entries.length - 1;
        out.push({ ...e, text: `${indent}${last ? '└── ' : '├── '}${e.text}` });
        if (e.dir && depth < TREE_DEPTH) await walk(e.open as string, depth + 1, `${indent}${last ? '    ' : '│   '}`);
      }
    };
    await walk(root, 1, '');
    if (out.length >= TREE_MAX) out.push({ text: '… (cut short; tree a smaller folder)', tone: 'muted' });
    return out;
  }

  /** A clicked name in the output: folders are listed (cd + ls), files open in the viewer. */
  async openEntry(id: string, rel: string, dir: boolean): Promise<void> {
    if (!dir) return this.run(id, `open "/${rel}"`);
    await this.run(id, `cd "/${rel}"`);
    await this.run(id, 'ls');
  }
}

function helpLines(owner: string, w: SharedWorkspace): ShellLine[] {
  return [
    { text: `A read-only shell over ${owner}'s ${w.name}. Files stream in as you open them; nothing runs on ${owner}'s computer.`, tone: 'muted' },
    ...SHELL_COMMANDS.map((c) => ({ text: `  ${c.usage.padEnd(16)}${c.about}` })),
    { text: 'Tab completes names, ↑ brings back earlier commands, click any name to open it.', tone: 'muted' },
    ...(w.can === 'edit' ? [{ text: `${owner} lets your prompts edit and run commands: ask Claude in the Chat tab to run anything there.`, tone: 'muted' as const }] : []),
  ];
}
