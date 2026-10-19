import type { ChatFile, GroupView, LiveClaude, MessageView, NetworkState } from '../../../../src/net/mesh/views.js';

/**
 * What the chats say and decide, as plain functions (no React, no daemon): whose Claude a
 * message asks, file sizes and kinds, who's thinking, and the open chat tabs.
 */

/** Whose Claude the next message asks: yours, everyone's in the conversation, or one person's. */
export type Ask = { readonly kind: 'me' } | { readonly kind: 'all' } | { readonly kind: 'person'; readonly peerId: string; readonly name: string };

/** "Asking your Claude" (or, short for the button: "Your Claude"). */
export function askLabel(ask: Ask, short = false): string {
  if (ask.kind === 'me') return short ? 'Your Claude' : 'Asking your Claude';
  if (ask.kind === 'all') return short ? 'Everyone’s Claude' : 'Asking everyone’s Claude';
  return short ? `${ask.name}’s Claude` : `Asking ${ask.name}’s Claude`;
}

/** What the message tells the network: everyone, or these people's Claudes. */
export const askTo = (ask: Ask, me: string): 'all' | readonly string[] => (ask.kind === 'all' ? 'all' : ask.kind === 'me' ? [me] : [ask.peerId]);

/** Under a message that asked: "Asked everyone’s Claude", "Asked bob’s Claude", "Asked your Claude". */
export function askedLine(m: Pick<MessageView, 'ask' | 'mine' | 'from'>, nameOf: (peerId: string) => string, me: string | undefined): string | undefined {
  const to = m.ask?.to;
  if (!to) return undefined;
  if (to === 'all') return 'Asked everyone’s Claude';
  const names = to.map((p) => (p === me ? (m.mine ? 'their own' : 'your') : `${nameOf(p)}’s`));
  if (m.mine) return `Asked ${to.length === 1 && to[0] === me ? 'your' : names.join(' and ')} Claude`;
  if (to.length === 1 && to[0] === m.from) return 'Asked their Claude';
  return `Asked ${names.join(' and ')} Claude`;
}

/** Who wrote it, as the chat shows it: "You", "bob", "Your Claude", "bob’s Claude". */
export function authorLabel(m: Pick<MessageView, 'mine' | 'name' | 'claude'>): string {
  if (m.claude) return m.mine ? 'Your Claude' : `${m.name}’s Claude`;
  return m.mine ? 'You' : m.name;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** "PDF", "ZIP", "PNG" (from the name), or "File". */
export function kindLabel(f: Pick<ChatFile, 'name'>): string {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(f.name)?.[1];
  return ext ? ext.toUpperCase() : 'File';
}

/** Claudes answering in this conversation now (newest last), without stale ones. */
export function liveIn(state: Pick<NetworkState, 'live'>, conversation: string, now = Date.now(), ttl = 3 * 60_000): readonly LiveClaude[] {
  return (state.live?.[conversation] ?? []).filter((l) => now - l.since < ttl);
}

/** "bob’s Claude is answering…", "Your Claude and mia’s Claude are answering…". */
export function liveLine(live: readonly LiveClaude[], me: string | undefined): string {
  const names = [...new Set(live.map((l) => (l.peerId === me ? 'Your Claude' : `${l.name}’s Claude`)))];
  if (!names.length) return '';
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? 'is' : 'are'} answering…`;
}

// ---- chat tabs

/** The main channel's tab: always first, there even before the channel exists. */
export const MAIN_TAB = 'main';

/** Tabs to show: the main channel first, then the ones you opened (that still exist), and the one on screen. */
export function chatTabs(open: readonly string[], shown: string | undefined, state: Pick<NetworkState, 'main' | 'friends' | 'groups'>): string[] {
  const main = state.main ? `group:${state.main}` : undefined;
  const exists = (id: string): boolean => (id.startsWith('dm:') ? state.friends.some((f) => `dm:${f.peerId}` === id) : state.groups.some((g) => `group:${g.id}` === id));
  const list = [...open, ...(shown && !open.includes(shown) ? [shown] : [])].filter((id) => id !== main && id !== MAIN_TAB && exists(id));
  return [MAIN_TAB, ...new Set(list)];
}

/** Open a conversation's tab (at the end, if it isn't open already). */
export const openTab = (open: readonly string[], id: string): string[] => (open.includes(id) ? [...open] : [...open, id]);

/** Close a tab; → the tabs left and where to go if it was the one on screen (its neighbour, else the main channel). */
export function closeTab(open: readonly string[], id: string): { open: string[]; next: string } {
  const at = open.indexOf(id);
  const left = open.filter((t) => t !== id);
  return { open: left, next: left[Math.min(Math.max(at, 0), left.length - 1)] ?? MAIN_TAB };
}

/** Is this group the main channel (yours)? */
export const isMain = (state: Pick<NetworkState, 'main'>, g: Pick<GroupView, 'id'> | undefined): boolean => Boolean(g && state.main === g.id);

/** A channel's name as you see it: yours is "All Friends". */
export const channelName = (state: Pick<NetworkState, 'main'>, g: Pick<GroupView, 'id' | 'name'>): string => (isMain(state, g) ? 'All Friends' : g.name);
