import type { MessageView, NetworkState, NetworkSummary } from '../net/mesh/views.js';

/**
 * The klaud network in the shared state: friends with their status, groups with members,
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
  /** The network stopped. */
  | { type: 'net_off' };

function withMessage(list: readonly MessageView[], m: MessageView): readonly MessageView[] {
  const at = list.findIndex((x) => x.id === m.id);
  if (at >= 0) return list.map((x, i) => (i === at ? m : x));
  return [...list, m].slice(-KEEP_MESSAGES);
}

export function reduceNetwork(state: NetworkSlice, action: NetworkAction): NetworkSlice {
  switch (action.type) {
    case 'net_summary':
      return { network: { ...action.summary, messages: state.network.messages } };
    case 'net_message': {
      const { conversation } = action.message;
      const messages = { ...state.network.messages, [conversation]: withMessage(state.network.messages[conversation] ?? [], action.message) };
      return { network: { ...state.network, messages } };
    }
    case 'net_messages':
      return { network: { ...state.network, messages: { ...state.network.messages, ...Object.fromEntries(Object.entries(action.messages).map(([k, v]) => [k, v.slice(-KEEP_MESSAGES)])) } } };
    case 'net_off':
      return { network: NO_NETWORK };
    default:
      return state;
  }
}
