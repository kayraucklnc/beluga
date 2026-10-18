import { statSync } from 'node:fs';
import os from 'node:os';
import { tilde } from '../core/paths.js';
import path from 'node:path';
import { ATTACHMENT_SCHEME } from '../core/attachments.js';
import type { AppState, LogItem } from '../core/store.js';
import { type Line, type Seg, width } from './text.js';
import { theme } from './theme.js';
import { findWorkspace } from './workspace-models.js';

/** Where a link in the chat goes. `href` is a Markdown link target not resolved yet. */
export type LinkTarget =
  | { readonly kind: 'local'; readonly path: string; readonly dir: boolean; readonly line?: number }
  | { readonly kind: 'peer'; readonly owner: string; readonly share: string; readonly path: string; readonly line?: number }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'attachment'; readonly owner: string; readonly file: string; readonly label: string }
  | { readonly kind: 'href'; readonly href: string };

/** A path or URL found in a piece of text. */
export interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly kind: 'url' | 'path';
  /** The URL, or the path without its line suffix. */
  readonly value: string;
  readonly line?: number;
}


const URL_RE = /\bhttps?:\/\/[^\s<>"'`\])]+/g;
const PATH_RE = /(?<![\w@.\/~:\\-])((?:~|\.{1,2})?\/?(?:\.?[\w@+-][\w.@+-]*\/?)+)(?::(\d+)(?::\d+)?|#L(\d+))?/g;
const HAS_EXT = /\.[A-Za-z][\w-]{0,9}$/;

/** Text that could name a file: has a folder separator or a file extension (README.md, src/, ~/x). */
export function plausiblePath(p: string): boolean {
  if (!/[A-Za-z]/.test(p) || p.length < 2) return false;
  if (p.includes('/')) return !/^\/+$/.test(p) && !p.startsWith('//');
  return HAS_EXT.test(p);
}

/** Find URLs and path-like words in text (pure: nothing is checked on disk). */
export function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const taken: Array<[number, number]> = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const start = m.index ?? 0;
    out.push({ start, end: start + url.length, kind: 'url', value: url });
    taken.push([start, start + m[0].length]);
  }
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index ?? 0;
    if (taken.some(([a, b]) => start < b && start + m[0].length > a)) continue;
    let value = m[1] ?? '';
    const lineNo = m[2] ?? m[3];
    // A sentence's full stop isn't part of the path.
    let end = start + m[0].length;
    if (!lineNo) {
      const trimmed = value.replace(/\.+$/, '');
      end -= value.length - trimmed.length;
      value = trimmed;
    }
    if (!plausiblePath(value)) continue;
    out.push({ start, end, kind: 'path', value, ...(lineNo ? { line: Number(lineNo) } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- checking paths on disk (cached: rendering must never wait on the disk twice)

const STAT_TTL_MS = 20_000;
const STAT_MAX = 4000;
const statCache = new Map<string, { at: number; dir?: boolean }>();

/** Whether a path exists and is a folder, remembered for a while. `undefined` = doesn't exist. */
export function statCached(abs: string, now = Date.now()): { dir: boolean } | undefined {
  const hit = statCache.get(abs);
  if (hit && now - hit.at < STAT_TTL_MS) return hit.dir === undefined ? undefined : { dir: hit.dir };
  let dir: boolean | undefined;
  try {
    dir = statSync(abs).isDirectory();
  } catch {
    dir = undefined;
  }
  if (statCache.size > STAT_MAX) statCache.clear();
  statCache.set(abs, { at: now, dir });
  return dir === undefined ? undefined : { dir };
}

export const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());

/** Resolve a path against folders on this computer; only paths that exist count. */
export function resolveLocal(p: string, roots: readonly string[], stat: (abs: string) => { dir: boolean } | undefined = statCached): { path: string; dir: boolean } | undefined {
  const expanded = expandHome(p.replace(/^file:\/\//, ''));
  const bases = path.isAbsolute(expanded) ? [''] : roots;
  for (const base of bases) {
    const abs = path.resolve(base, expanded);
    if (abs === path.parse(abs).root || abs === os.homedir()) continue;
    const st = stat(abs);
    if (st) return { path: abs, dir: st.dir };
  }
  return undefined;
}

// ---- where a message's paths point

export interface LinkEnv {
  /** Folders your own messages (and your Claude's) are relative to in the room: the current project, your shares. */
  readonly roots: () => readonly string[];
}
let env: LinkEnv = { roots: () => [process.cwd()] };
/** App tells the chat where relative paths in the room live. */
export function setLinkEnv(next: LinkEnv): void {
  env = next;
}

type Resolve = (c: Candidate | { kind: 'href'; value: string }) => LinkTarget | undefined;

/** How paths in one message resolve, from who wrote it and which conversation it's in. */
export function resolverFor(state: AppState, item: LogItem, stat?: (abs: string) => { dir: boolean } | undefined): Resolve | undefined {
  // Command output cards (shell) aren't scanned for links.
  if (item.type === 'system' || item.type === 'shell') return undefined;
  const author = item.type === 'agent' ? item.owner : item.from;
  const selfId = state.self?.peerId;
  const fromHref = (href: string): LinkTarget | undefined => {
    if (/^https?:\/\//.test(href)) return { kind: 'url', url: href };
    if (href.startsWith(ATTACHMENT_SCHEME)) {
      const [owner, file] = href.slice(ATTACHMENT_SCHEME.length).split('/');
      return owner && file && !file.includes('..') ? { kind: 'attachment', owner, file, label: '' } : undefined;
    }
    return undefined;
  };
  const lineOf = (c: { line?: number }) => (c.line ? { line: c.line } : {});
  const local = (roots: readonly string[]): Resolve => (c) => {
    if (c.kind === 'url') return { kind: 'url', url: c.value };
    if (c.kind === 'href') {
      const direct = fromHref(c.value);
      if (direct || !plausiblePath(c.value)) return direct;
    }
    const hit = resolveLocal(c.value, roots, stat);
    return hit ? { kind: 'local', ...hit, ...(c.kind === 'path' ? lineOf(c) : {}) } : undefined;
  };
  const peer = (owner: string, pick: (rel: string) => { share: string; path: string } | undefined): Resolve => (c) => {
    if (c.kind === 'url') return { kind: 'url', url: c.value };
    const direct = c.kind === 'href' ? fromHref(c.value) : undefined;
    if (direct) return direct;
    if (!plausiblePath(c.value) || path.isAbsolute(c.value) || c.value.startsWith('~') || c.value.split('/').includes('..')) return undefined;
    const at = pick(c.value.replace(/^\.\//, '').replace(/\/$/, ''));
    return at ? { kind: 'peer', owner, ...at, ...(c.kind === 'path' ? lineOf(c) : {}) } : undefined;
  };
  const channel = item.channel;
  if (channel.startsWith('ws:')) {
    const id = channel.slice(3);
    const ws = findWorkspace(state.projects, id);
    if (ws) return local([ws.path]);
    const shared = state.shared.find((w) => w.id === id);
    return shared ? peer(shared.owner, (rel) => ({ share: shared.share, path: rel })) : undefined;
  }
  if (author === selfId) return local(env.roots());
  // A friend's paths: only ones that start with a folder they share.
  const shares = state.peers.find((p) => p.peerId === author)?.shares ?? [];
  return peer(author, (rel) => {
    const [first, ...rest] = rel.split('/');
    return shares.some((s) => s.name === first) ? { share: first ?? '', path: rest.join('/') } : undefined;
  });
}

/** Split a rendered line's segments so paths and URLs in it become links. */
export function linkifyLine(line: Line, resolve: Resolve): Line {
  if (!line.some((s) => s.text.length > 1 || s.link)) return line;
  const out: Seg[] = [];
  let changed = false;
  for (const seg of line) {
    if (seg.link?.kind === 'href') {
      const link = resolve({ kind: 'href', value: seg.link.href });
      const { link: _drop, ...rest } = seg;
      out.push(link ? { ...rest, link: link.kind === 'attachment' ? { ...link, label: seg.text } : link } : rest);
      changed = true;
      continue;
    }
    const found = seg.link ? [] : findCandidates(seg.text);
    let last = 0;
    for (const c of found) {
      const link = resolve(c);
      if (!link) continue;
      if (c.start > last) out.push({ ...seg, text: seg.text.slice(last, c.start) });
      out.push({ ...seg, text: seg.text.slice(c.start, c.end), color: seg.color ?? theme.info, link });
      last = c.end;
      changed = true;
    }
    if (last === 0) out.push(seg);
    else if (last < seg.text.length) out.push({ ...seg, text: seg.text.slice(last) });
  }
  return changed ? out : line;
}

/** A link's place on a line (columns, inclusive). */
export interface LinkSpan {
  readonly x0: number;
  readonly x1: number;
  readonly link: LinkTarget;
}

/** Where the links sit in a line; neighbouring segments with the same target count as one. */
export function linkSpans(line: Line): LinkSpan[] {
  const spans: LinkSpan[] = [];
  let x = 0;
  for (const seg of line) {
    const w = width(seg.text);
    if (seg.link && w > 0) {
      const prev = spans.at(-1);
      if (prev && prev.x1 === x - 1 && sameLink(prev.link, seg.link)) spans[spans.length - 1] = { ...prev, x1: x + w - 1 };
      else spans.push({ x0: x, x1: x + w - 1, link: seg.link });
    }
    x += w;
  }
  return spans;
}

export const sameLink = (a: LinkTarget, b: LinkTarget): boolean => JSON.stringify(a) === JSON.stringify(b);

const shortPath = (p: string): string => tilde(p);

/** What hovering a link says in the bottom bar. */
export function linkHint(link: LinkTarget, cwd?: string): string {
  // Relative to the conversation's folder (in the room: your project or a shared folder), as people write them.
  const rel = (p: string): string => {
    const base = [...(cwd ? [cwd] : []), ...env.roots()].find((r) => p.startsWith(`${r}/`));
    return base ? p.slice(base.length + 1) : shortPath(p);
  };
  switch (link.kind) {
    case 'local':
      return `${link.dir ? 'Browse' : 'Open'} ${rel(link.path)}${link.dir ? '/' : ''}${link.line ? `:${link.line}` : ''} · click (⌥-click)`;
    case 'peer':
      return `Open ${link.share}/${link.path}${link.line ? `:${link.line}` : ''} on their computer · click`;
    case 'url':
      return `Open ${link.url.length > 70 ? `${link.url.slice(0, 69)}…` : link.url} in your browser · click`;
    case 'attachment':
      return `View ${link.label.replace(/^📎\s*/, '') || 'the image'} · click`;
    case 'href':
      return link.href;
  }
}

/** The chat's linkify option: each message's paths resolved for its author and conversation. */
export const chatLinkify = (state: AppState) => (item: LogItem): ((line: Line) => Line) | undefined => {
  const resolve = resolverFor(state, item);
  return resolve ? (line) => linkifyLine(line, resolve) : undefined;
};
