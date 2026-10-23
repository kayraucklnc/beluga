import { COMMANDS } from '../core/commands.js';
import type { Location } from '../core/store.js';
import type { FsEntry, PeerInfo } from '../protocol.js';

export interface Suggestion {
  /** What the list shows. */
  readonly label: string;
  /** Short explanation shown next to the label. */
  readonly hint: string;
  /** The full buffer after accepting this suggestion. */
  readonly value: string;
  /**
   * What Enter does while this suggestion is selected:
   * 'complete' fills it in (keep typing), 'submit' fills it in and sends it.
   */
  readonly enter: 'complete' | 'submit';
}

export interface SuggestContext {
  readonly peers: readonly PeerInfo[];
  readonly selfId: string;
  readonly dirCache?: Readonly<Record<string, readonly FsEntry[]>>;
  /** Lists folders on this computer for "/project add <path>" (entries' size = 1 marks a git project). */
  readonly listLocalDirs?: (dir: string) => readonly FsEntry[];
  /** "@workspace" targets, offered in the main chat. */
  readonly workspaces?: ReadonlyArray<{ readonly label: string; readonly hint: string }>;
  /** Friends on the Beluga network: "@mia" anywhere in a message asks your Claude to reach mia's Claude. */
  readonly friends?: ReadonlyArray<{ readonly name: string; readonly online: boolean }>;
  /** Your projects ("@bob-api"). */
  readonly projects?: ReadonlyArray<{ readonly name: string }>;
  /** A folder's entries in this conversation's worktree ("@src/auth.ts"); undefined while not loaded. */
  readonly entries?: (dir: string) => readonly FsEntry[] | undefined;
}

/** How a friend is written in a message: "@mia" ("@Mia Chen" → "@MiaChen", "@Zoë" stays). */
export const friendMention = (name: string): string => `@${name.replace(/[^\p{L}\p{N}_.-]+/gu, '')}`;

/** The "@…" being typed at the end of the box, without the @ (undefined: not typing a mention). */
export const typedMention = (buffer: string): string | undefined => /(?:^|\s)@([\p{L}\p{N}_.:/+-]*)$/u.exec(buffer)?.[1];

/** The worktree folder a typed "@src/au" lists ('' for the top), if it's a path at all. */
export function mentionDir(buffer: string): string | undefined {
  const token = typedMention(buffer);
  if (token === undefined || token.startsWith('/') || token.includes('..') || token.includes(':')) return undefined;
  const slash = token.lastIndexOf('/');
  return slash < 0 ? '' : token.slice(0, slash);
}

/** Folders and files of the worktree for "@src/au" (only once something is typed). */
function pathMentions(token: string, ctx: SuggestContext): Array<{ label: string; hint: string; folder: boolean }> {
  const dir = mentionDir(`@${token}`);
  if (dir === undefined || !ctx.entries || (!token.includes('/') && !token)) return [];
  const partial = token.slice(dir ? dir.length + 1 : 0).toLowerCase();
  const prefix = dir ? `${dir}/` : '';
  return (ctx.entries(dir) ?? [])
    .filter((e) => !e.name.startsWith('.') && e.name.toLowerCase().startsWith(partial))
    .slice(0, 40)
    .map((e) => ({ label: `@${prefix}${e.name}${e.dir ? '/' : ''}`, hint: e.dir ? 'folder' : 'file', folder: e.dir }));
}

/** The folder being typed after "/project add" (or folder): "~/Proj" → "~/". */
function splitTyped(typed: string): { dir: string; partial: string } {
  const raw = typed || '~/';
  const slash = raw.lastIndexOf('/');
  return { dir: (slash >= 0 ? raw.slice(0, slash + 1) : '') || './', partial: (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase() };
}

/** Which folder on this computer to list for what's typed (undefined: not typing a project path). */
export function localDirOf(buffer: string): string | undefined {
  const m = /^\/project (add|folder) (.*)$/i.exec(buffer);
  return m ? splitTyped(m[2] ?? '').dir : undefined;
}

/** Folder completion for adding projects: "~/Proj" → "~/Projects/". */
function localPathSuggestions(sub: string, typed: string, ctx: SuggestContext): Suggestion[] {
  if (!ctx.listLocalDirs) return [];
  const { dir: listed, partial } = splitTyped(typed);
  const dir = listed === './' && !typed.includes('/') ? '' : listed;
  return ctx
    .listLocalDirs(listed)
    .filter((e) => e.dir && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(partial))
    .map((e) => ({
      label: `${e.name}/`,
      hint: e.size === 1 ? 'git project · Enter adds it' : 'folder',
      value: `/project ${sub} ${dir}${e.name}${e.size === 1 && sub === 'add' ? '' : '/'}`,
      enter: e.size === 1 && sub === 'add' ? ('submit' as const) : ('complete' as const),
    }));
}

const MAX = 300;
/** How many suggestions are visible at once; the list scrolls to follow the highlight. */
export const VISIBLE_SUGGESTIONS = 7;

/** The slice of suggestions to draw so the highlighted one is always in view. */
export function suggestionWindow(total: number, selected: number): { start: number; end: number; above: number; below: number; rows: number } {
  const visible = Math.min(total, VISIBLE_SUGGESTIONS);
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), total - visible));
  const end = start + visible;
  const above = start;
  const below = total - end;
  return { start, end, above, below, rows: visible + (total > VISIBLE_SUGGESTIONS ? 1 : 0) };
}
const PEER_COMMANDS = new Set(['follow', 'trust', 'untrust']);
const OPEN_SPEC = /^\/(?:open|e|get) ([\w.-]+):([\w.-]+)\/(.*)$/;

function commandSuggestions(buffer: string): Suggestion[] {
  const typed = buffer.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(typed)).map((c) => ({
    label: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
    hint: c.desc,
    value: `/${c.name}${c.args ? ' ' : ''}`,
    enter: 'complete' as const,
  }));
}

/** The folder whose contents should be suggested for the current `/open` buffer. */
export function openTarget(buffer: string, peers: readonly PeerInfo[]): Location | undefined {
  const m = OPEN_SPEC.exec(buffer);
  if (!m) return undefined;
  const peer = peers.find((p) => p.name.toLowerCase() === m[1]?.toLowerCase());
  if (!peer || !peer.shares.some((s) => s.name === m[2])) return undefined;
  const rest = m[3] ?? '';
  return { owner: peer.peerId, share: m[2] as string, path: rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : '' };
}

function openSuggestions(partial: string, ctx: SuggestContext): Suggestion[] {
  const target = openTarget(`/open ${partial}`, ctx.peers);
  if (!target) {
    return ctx.peers
      .flatMap((p) => p.shares.map((s) => `${p.name}:${s.name}/`))
      .filter((spec) => spec.toLowerCase().startsWith(partial.toLowerCase()))
      .map((spec) => ({ label: spec, hint: 'shared folder', value: `/open ${spec}`, enter: 'complete' as const }));
  }
  const entries = ctx.dirCache?.[`${target.owner}:${target.share}/${target.path}`] ?? [];
  const typed = partial.slice(partial.lastIndexOf('/') + 1).toLowerCase();
  const prefix = partial.slice(0, partial.lastIndexOf('/') + 1);
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(typed))
    .map((e) => ({
      label: `${e.name}${e.dir ? '/' : ''}`,
      hint: e.dir ? 'folder' : 'file',
      value: `/open ${prefix}${e.name}${e.dir ? '/' : ''}`,
      enter: e.dir ? ('complete' as const) : ('submit' as const),
    }));
}

function argumentSuggestions(cmd: string, partial: string, ctx: SuggestContext): Suggestion[] {
  const lower = partial.toLowerCase();
  if (PEER_COMMANDS.has(cmd)) {
    return ctx.peers
      .filter((p) => p.peerId !== ctx.selfId && p.name.toLowerCase().startsWith(lower))
      .map((p) => ({ label: p.name, hint: p.agent ? 'has Claude on' : '', value: `/${cmd} ${p.name}`, enter: 'submit' as const }));
  }
  if (cmd === 'open' || cmd === 'e' || cmd === 'get') return openSuggestions(partial, ctx).map((s) => ({ ...s, value: s.value.replace(/^\/open /, `/${cmd} `) }));
  if (cmd === 'policy') {
    const opts = { ask: 'approve each request', auto: 'run without asking', deny: 'refuse all requests' } as const;
    return (Object.keys(opts) as Array<keyof typeof opts>)
      .filter((k) => k.startsWith(lower))
      .map((k) => ({ label: k, hint: opts[k], value: `/policy ${k}`, enter: 'submit' as const }));
  }
  return [];
}

function mentionSuggestions(buffer: string, ctx: SuggestContext): Suggestion[] {
  const typed = typedMention(buffer);
  if (typed === undefined) return [];
  const token = `@${typed}`.toLowerCase();
  const before = buffer.slice(0, buffer.length - token.length);
  // Inside a folder: only what's in it ("@src/" → "@src/auth.ts").
  if (typed.includes('/')) {
    return pathMentions(typed, ctx)
      .filter((o) => o.label.toLowerCase() !== token)
      .map((o) => ({ label: o.label, hint: o.hint, value: `${before}${o.label}${o.folder ? '' : ' '}`, enter: 'complete' as const }));
  }
  const options: Array<{ label: string; hint: string }> = [
    { label: '@claude', hint: 'ask your Claude' },
    ...ctx.peers
      .filter((p) => p.agent && p.peerId !== ctx.selfId)
      .map((p) => ({ label: `@claude:${p.name}`, hint: `ask ${p.name}'s Claude (on their machine)` })),
    ...(ctx.peers.length > 1 ? [{ label: '@claudes', hint: 'ask every Claude in the room' }] : []),
    ...(ctx.friends ?? [])
      .filter((f) => friendMention(f.name).length > 1)
      .map((f) => ({ label: friendMention(f.name), hint: `ask ${f.name}'s Claude, on their Mac${f.online ? '' : ' (offline: it goes when they’re back)'}` })),
    ...(ctx.projects ?? []).map((p) => ({ label: `@${p.name}`, hint: 'a project' })),
    // Only at the start: "@add-auth …" sends the whole message to that workspace's Claude.
    ...(before.trim() ? [] : (ctx.workspaces ?? [])),
  ];
  const named = options
    .filter((o) => o.label.toLowerCase().startsWith(token) && o.label.toLowerCase() !== token)
    .map((o) => ({ ...o, value: `${before}${o.label} `, enter: 'complete' as const }));
  const seen = new Set(named.map((o) => o.label.toLowerCase()));
  const paths = pathMentions(typed, ctx)
    .filter((o) => !seen.has(o.label.toLowerCase()))
    .map((o) => ({ label: o.label, hint: o.hint, value: `${before}${o.label}${o.folder ? '' : ' '}`, enter: 'complete' as const }));
  return [...named, ...paths];
}

/** Autocomplete for the composer: /commands, their arguments (incl. file paths), and @mentions. */
export function suggest(buffer: string, ctx: SuggestContext): Suggestion[] {
  if (buffer.startsWith('/') && !buffer.startsWith('//')) {
    const space = buffer.indexOf(' ');
    if (space === -1) return commandSuggestions(buffer).slice(0, MAX);
    const cmd = buffer.slice(1, space).toLowerCase();
    const rest = buffer.slice(space + 1);
    const project = /^(add|folder) (.*)$/.exec(rest);
    if (cmd === 'project' && project) return localPathSuggestions(project[1] ?? 'add', project[2] ?? '', ctx);
    if (cmd === 'project') {
      return [
        { label: 'add <path>', hint: 'add one git project', value: '/project add ~/', enter: 'complete' as const },
        { label: 'folder <path>', hint: 'watch a folder of projects', value: '/project folder ~/', enter: 'complete' as const },
      ].filter((s) => s.label.startsWith(rest));
    }
    if (rest.includes(' ')) return [];
    return argumentSuggestions(cmd, rest, ctx).slice(0, MAX);
  }
  return mentionSuggestions(buffer, ctx).slice(0, MAX);
}
