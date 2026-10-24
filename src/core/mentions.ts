import type { PeerInfo } from '../protocol.js';
import { worktreeOrigin } from '../workspaces/origin.js';
import type { Project } from '../workspaces/types.js';

export type ParsedInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'command'; readonly name: string; readonly args: readonly string[] }
  | { readonly kind: 'chat'; readonly text: string }
  | {
      readonly kind: 'agent';
      readonly text: string;
      readonly prompt: string;
      readonly targets: readonly string[];
      readonly unknown: readonly string[];
    };

const MENTION = /^@(claudes|claude(?::([\w.-]+))?)$/i;

/**
 * Turn a line typed in the prompt into an action.
 *   /cmd args         -> command (":cmd" also works; "//text" sends "/text")
 *   @claude fix it    -> your own agent
 *   @claude:bob hi    -> bob's agent (runs on bob's machine, on bob's subscription)
 *   @claudes review   -> every agent in the room
 *   anything else     -> group chat
 */
export function parseInput(raw: string, selfId: string, peers: readonly PeerInfo[]): ParsedInput {
  const text = raw.trim();
  if (!text) return { kind: 'empty' };
  if (text.startsWith('//')) return { kind: 'chat', text: text.slice(1) };
  if (text.startsWith(':') || text.startsWith('/')) {
    const [name = '', ...args] = text.slice(1).trim().split(/\s+/);
    return { kind: 'command', name: name.toLowerCase(), args };
  }

  const tokens = text.split(/\s+/);
  const targets: string[] = [];
  const unknown: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const match = MENTION.exec(tokens[i] ?? '');
    if (!match) break;
    if (match[1]?.toLowerCase() === 'claudes') {
      targets.push(...peers.filter((p) => p.agent).map((p) => p.peerId));
    } else if (match[2]) {
      const peer = peers.find((p) => p.name.toLowerCase() === match[2]?.toLowerCase());
      if (peer) targets.push(peer.peerId);
      else unknown.push(match[2]);
    } else {
      targets.push(selfId);
    }
  }
  if (i === 0) return { kind: 'chat', text };
  const prompt = tokens.slice(i).join(' ');
  if (!prompt) return { kind: 'chat', text };
  return { kind: 'agent', text, prompt, targets: [...new Set(targets)], unknown };
}

/** Parse `peer:share/path/to/file` used by `:open`. */
export function parseLocation(
  spec: string,
  peers: readonly PeerInfo[],
): { owner: string; share: string; path: string } | undefined {
  const m = /^([\w.-]+):([\w.-]+)(?:\/(.*))?$/.exec(spec);
  if (!m) return undefined;
  const peer = peers.find((p) => p.name.toLowerCase() === m[1]?.toLowerCase());
  if (!peer || !peer.shares.some((s) => s.name === m[2])) return undefined;
  return { owner: peer.peerId, share: m[2] as string, path: m[3] ?? '' };
}

/** A workspace you can message from the main chat with "@name". */
export interface WorkspaceMention {
  readonly label: string;
  readonly id: string;
  readonly hint: string;
}

/**
 * "@add-auth" for every live workspace (worktrees, chats, main folders) on this computer.
 * Names used twice get their project in front: "@api/add-auth".
 */
export function workspaceMentions(projects: readonly Project[]): WorkspaceMention[] {
  const all = projects.flatMap((p) => p.workspaces.filter((w) => !w.archived && w.kind !== 'main' && worktreeOrigin(w) !== 'agent').map((w) => ({ p, w })));
  const slug = (s: string) => s.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const counts = new Map<string, number>();
  for (const { w } of all) counts.set(slug(w.name), (counts.get(slug(w.name)) ?? 0) + 1);
  return all.map(({ p, w }) => {
    const name = slug(w.name);
    const label = (counts.get(name) ?? 0) > 1 && p.root ? `@${slug(p.name)}/${name}` : `@${name}`;
    const where = p.root ? `${p.name} · ${w.kind === 'chat' ? 'chat' : 'worktree'}` : 'chat';
    return { label, id: w.id, hint: `message the Claude in ${where}` };
  });
}

/** "@add-auth fix the test" → the workspace and the message, when it names one of yours. */
export function parseWorkspaceMention(raw: string, mentions: readonly WorkspaceMention[]): { id: string; label: string; prompt: string } | undefined {
  const m = /^(@[\w./-]+)\s+([\s\S]+)$/.exec(raw.trim());
  if (!m) return undefined;
  const hit = mentions.find((x) => x.label.toLowerCase() === m[1]!.toLowerCase());
  return hit ? { id: hit.id, label: hit.label, prompt: m[2]!.trim() } : undefined;
}
