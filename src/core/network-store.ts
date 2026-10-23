import type { ChatFileState, LiveClaude, MessageView, NetworkState, NetworkSummary } from '../net/mesh/views.js';

/**
 * The Beluga network in the shared state: friends with their status, groups with members,
 * unread counts and last messages, open invitations, and the latest messages per conversation.
 * No keys or secrets ever get here (see net/mesh/views.ts). Browser-safe: the Mac app runs it.
 */

export interface NetworkSlice {
  readonly network: NetworkState;
}

export const NO_NETWORK: NetworkState = { enabled: false, friends: [], groups: [], invitations: [], pendingJoins: [], messages: {} };

export const initialNetwork: NetworkSlice = { network: NO_NETWORK };

/** Messages kept per conversation in the shared state (older ones: the history API). */
export const KEEP_MESSAGES = 200;

export type NetworkAction =
  /** People, groups, presence or invitations changed. */
  | { type: 'net_summary'; summary: NetworkSummary }
  /** A message arrived, was sent, or changed status (same id: replaced). */
  | { type: 'net_message'; message: MessageView }
  /** The latest messages of these conversations (on start). */
  | { type: 'net_messages'; messages: Readonly<Record<string, readonly MessageView[]>> }
  /** Chat files changed state (`null`: forget it). */
  | { type: 'net_files'; files: Readonly<Record<string, ChatFileState | null>> }
  /** Someone's Claude started (`live`) or stopped (`idle`) answering in a conversation. */
  | { type: 'net_live'; conversation: string; live: LiveClaude; state: 'thinking' | 'idle' }
  /** Your main channel is this group. */
  | { type: 'net_main'; groupId: string | undefined }
  /** The network stopped. */
  | { type: 'net_off' };

/** A Claude that said nothing for this long isn't shown as answering any more. */
export const LIVE_TTL_MS = 3 * 60_000;

/** Answers one person's Claude is shown working on in one conversation, at most. */
const LIVE_PER_PERSON = 4;

function withLive(list: readonly LiveClaude[] | undefined, live: LiveClaude, state: 'thinking' | 'idle'): readonly LiveClaude[] {
  const rest = (list ?? []).filter((l) => !(l.peerId === live.peerId && l.for === live.for) && live.since - l.since < LIVE_TTL_MS);
  if (state !== 'thinking') return rest;
  const theirs = rest.filter((l) => l.peerId === live.peerId);
  const drop = new Set(theirs.slice(0, Math.max(0, theirs.length - LIVE_PER_PERSON + 1)));
  return [...rest.filter((l) => !drop.has(l)), live];
}

function withMessage(list: readonly MessageView[], m: MessageView): readonly MessageView[] {
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0) return list.map((x, i) => (i === at ? m : x));
  return [...list, m].slice(-KEEP_MESSAGES);
}

export function reduceNetwork(state: NetworkSlice, action: NetworkAction): NetworkSlice {
  switch (action.type) {
    case 'net_summary': {
      const { files, live, main } = state.network;
      return { network: { ...action.summary, messages: state.network.messages, ...(files ? { files } : {}), ...(live ? { live } : {}), ...(main ? { main } : {}) } };
    }
    case 'net_message': {
      const m = action.message;
      const messages = { ...state.network.messages, [m.conversation]: withMessage(state.network.messages[m.conversation] ?? [], m) };
      // A Claude's answer arrived: it isn't "thinking" any more.
      const was = state.network.live?.[m.conversation];
      const answered = m.claude && was?.some((l) => l.peerId === m.from && l.for === m.claude!.for);
      const live = answered ? { ...state.network.live, [m.conversation]: was!.filter((l) => !(l.peerId === m.from && l.for === m.claude!.for)) } : state.network.live;
      return { network: { ...state.network, messages, ...(live ? { live } : {}) } };
    }
    case 'net_files': {
      const files: Record<string, ChatFileState> = { ...state.network.files };
      for (const [sha, f] of Object.entries(action.files)) {
        if (f) files[sha] = f;
        else delete files[sha];
      }
      return { network: { ...state.network, files } };
    }
    case 'net_live':
      return { network: { ...state.network, live: { ...state.network.live, [action.conversation]: withLive(state.network.live?.[action.conversation], action.live, action.state) } } };
    case 'net_main': {
      const { main: _old, ...rest } = state.network;
      return { network: action.groupId ? { ...rest, main: action.groupId } : rest };
    }
    case 'net_messages':
      return { network: { ...state.network, messages: { ...state.network.messages, ...Object.fromEntries(Object.entries(action.messages).map(([k, v]) => [k, v.slice(-KEEP_MESSAGES)])) } } };
    case 'net_off':
      return { network: NO_NETWORK };
    default:
      return state;
  }
}
