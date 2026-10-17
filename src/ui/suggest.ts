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
}

const MAX = 6;
const PEER_COMMANDS = new Set(['follow', 'trust', 'untrust']);
const OPEN_SPEC = /^\/(?:open|e) ([\w.-]+):([\w.-]+)\/(.*)$/;

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
  if (cmd === 'open' || cmd === 'e') return openSuggestions(partial, ctx);
  if (cmd === 'policy') {
    const opts = { ask: 'approve each request', auto: 'run without asking', deny: 'refuse all requests' } as const;
    return (Object.keys(opts) as Array<keyof typeof opts>)
      .filter((k) => k.startsWith(lower))
      .map((k) => ({ label: k, hint: opts[k], value: `/policy ${k}`, enter: 'submit' as const }));
  }
  return [];
}

function mentionSuggestions(buffer: string, ctx: SuggestContext): Suggestion[] {
  const m = /(^|\s)(@[\w.:-]*)$/.exec(buffer);
  if (!m) return [];
  const token = (m[2] ?? '').toLowerCase();
  const before = buffer.slice(0, buffer.length - token.length);
  const options: Array<{ label: string; hint: string }> = [
    { label: '@claude', hint: 'ask your Claude' },
    ...ctx.peers
      .filter((p) => p.agent && p.peerId !== ctx.selfId)
      .map((p) => ({ label: `@claude:${p.name}`, hint: `ask ${p.name}'s Claude (on their machine)` })),
    { label: '@claudes', hint: 'ask every Claude in the room' },
  ];
  return options
    .filter((o) => o.label.toLowerCase().startsWith(token) && o.label.toLowerCase() !== token)
    .map((o) => ({ ...o, value: `${before}${o.label} `, enter: 'complete' as const }));
}

/** Autocomplete for the composer: /commands, their arguments (incl. file paths), and @mentions. */
export function suggest(buffer: string, ctx: SuggestContext): Suggestion[] {
  if (buffer.startsWith('/') && !buffer.startsWith('//')) {
    const space = buffer.indexOf(' ');
    if (space === -1) return commandSuggestions(buffer).slice(0, MAX);
    const cmd = buffer.slice(1, space).toLowerCase();
    const rest = buffer.slice(space + 1);
    if (rest.includes(' ')) return [];
    return argumentSuggestions(cmd, rest, ctx).slice(0, MAX);
  }
  return mentionSuggestions(buffer, ctx).slice(0, MAX);
}
