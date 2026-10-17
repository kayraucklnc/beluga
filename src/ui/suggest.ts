import { COMMANDS } from '../core/commands.js';
import type { PeerInfo } from '../protocol.js';

export interface Suggestion {
  /** What the list shows. */
  readonly label: string;
  /** Short explanation shown next to the label. */
  readonly hint: string;
  /** The full buffer after accepting this suggestion. */
  readonly value: string;
}

const MAX = 6;
const PEER_COMMANDS = new Set(['follow', 'trust', 'untrust']);

function commandSuggestions(buffer: string): Suggestion[] {
  const typed = buffer.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(typed)).map((c) => ({
    label: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
    hint: c.desc,
    value: `/${c.name}${c.args ? ' ' : ''}`,
  }));
}

function argumentSuggestions(cmd: string, partial: string, peers: readonly PeerInfo[], selfId: string): Suggestion[] {
  const lower = partial.toLowerCase();
  if (PEER_COMMANDS.has(cmd)) {
    return peers
      .filter((p) => p.peerId !== selfId && p.name.toLowerCase().startsWith(lower))
      .map((p) => ({ label: p.name, hint: p.agent ? 'has Claude on' : '', value: `/${cmd} ${p.name}` }));
  }
  if (cmd === 'open') {
    return peers
      .flatMap((p) => p.shares.map((s) => `${p.name}:${s.name}/`))
      .filter((spec) => spec.toLowerCase().startsWith(lower))
      .map((spec) => ({ label: spec, hint: 'shared folder', value: `/open ${spec}` }));
  }
  if (cmd === 'policy') {
    const opts = { ask: 'approve each request', auto: 'run without asking', deny: 'refuse all requests' } as const;
    return (Object.keys(opts) as Array<keyof typeof opts>)
      .filter((k) => k.startsWith(lower))
      .map((k) => ({ label: k, hint: opts[k], value: `/policy ${k}` }));
  }
  return [];
}

function mentionSuggestions(buffer: string, peers: readonly PeerInfo[], selfId: string): Suggestion[] {
  const m = /(^|\s)(@[\w.:-]*)$/.exec(buffer);
  if (!m) return [];
  const token = (m[2] ?? '').toLowerCase();
  const before = buffer.slice(0, buffer.length - token.length);
  const options: Array<{ label: string; hint: string }> = [
    { label: '@claude', hint: 'ask your Claude' },
    ...peers.filter((p) => p.agent && p.peerId !== selfId).map((p) => ({ label: `@claude:${p.name}`, hint: `ask ${p.name}'s Claude (on their machine)` })),
    { label: '@claudes', hint: 'ask every Claude in the room' },
  ];
  return options
    .filter((o) => o.label.toLowerCase().startsWith(token) && o.label.toLowerCase() !== token)
    .map((o) => ({ ...o, value: `${before}${o.label} ` }));
}

/** Autocomplete for the composer: /commands, their arguments, and @mentions. */
export function suggest(buffer: string, peers: readonly PeerInfo[], selfId: string): Suggestion[] {
  if (buffer.startsWith('/') && !buffer.startsWith('//')) {
    const space = buffer.indexOf(' ');
    if (space === -1) return commandSuggestions(buffer).slice(0, MAX);
    const cmd = buffer.slice(1, space).toLowerCase();
    const rest = buffer.slice(space + 1);
    if (rest.includes(' ')) return [];
    return argumentSuggestions(cmd, rest, peers, selfId).slice(0, MAX);
  }
  return mentionSuggestions(buffer, peers, selfId).slice(0, MAX);
}
