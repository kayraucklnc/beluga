import type { FriendView, GroupView, NetworkState } from '@beluga/net/mesh/views.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { dmId, groupId } from './net-model.js';
import { getPrefs, setPrefs } from '../lib/prefs.js';
import { showPanelTab } from '../lib/panel.js';

/** The Beluga network as the shared state has it. */
export const useNetwork = (): NetworkState => useApp((st) => st.network);

export const useFriend = (peerId: string | undefined): FriendView | undefined => useApp((st) => (peerId ? st.network.friends.find((f) => f.peerId === peerId) : undefined));

export const useGroup = (id: string | undefined): GroupView | undefined => useApp((st) => (id ? st.network.groups.find((g) => g.id === id) : undefined));

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run an API call whose failure this screen shows itself (in a sheet, under a field): the
 * client's generic "Something went wrong" toast is taken back so it isn't said twice.
 */
export async function quietly<T>(client: SocketClient, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    const toast = client.store.getState().toast;
    if (toast && toast.text.includes(message(err).slice(0, 60))) client.store.dispatch({ type: 'toast_clear', id: toast.id });
    throw err instanceof Error ? err : new Error(message(err));
  }
}

/** Go to a conversation with a friend or a group (its chat tab opens too). */
export function openConversation(client: SocketClient, id: string): void {
  const tabs = getPrefs().chatTabs;
  if (!tabs.includes(id) && id !== (client.store.getState().network.main ? groupId(client.store.getState().network.main!) : '')) setPrefs({ chatTabs: [...tabs, id] });
  client.store.dispatch({ type: 'view', view: { kind: 'conversation', id } });
}

export const openDm = (client: SocketClient, peerId: string): void => openConversation(client, dmId(peerId));
export const openGroup = (client: SocketClient, id: string): void => openConversation(client, groupId(id));

/**
 * A friend's card: their conversation with its Info panel open, where how much you trust them is
 * set (the only place it's changed, BLG-202).
 */
export function openFriendCard(client: SocketClient, peerId: string): void {
  openDm(client, peerId);
  showPanelTab({ view: { kind: 'conversation', id: dmId(peerId) }, projects: client.store.getState().projects }, 'info');
}

/** Ask someone in your room to be friends (turning the network on first if it's off). */
export async function befriend(client: SocketClient, peerId: string, name: string): Promise<void> {
  const say = (text: string, level: 'success' | 'error'): void => client.store.dispatch({ type: 'toast', text, level });
  try {
    if (!client.store.getState().network.enabled) await quietly(client, client.api.network.setEnabled(true));
    await quietly(client, client.api.network['friends.addFromRoom'](peerId));
    say(`Sent ${name} a friend request. You’re friends once they accept`, 'success');
  } catch (err) {
    say(message(err), 'error');
  }
}

/** Accept (or not now) a friend request from someone in your room. */
export async function answerOffer(client: SocketClient, peerId: string, name: string, accept: boolean): Promise<void> {
  try {
    await quietly(client, client.api.network['friends.answerOffer'](peerId, accept));
    if (accept) client.store.dispatch({ type: 'toast', text: `You and ${name} are friends now`, level: 'success' });
  } catch (err) {
    client.store.dispatch({ type: 'toast', text: message(err).replace(/^Something went wrong: /, ''), level: 'error' });
  }
}

/** The conversation on screen, if it's one with friends. */
export const useShownConversation = (): string | undefined => useApp((st) => (st.view.kind === 'conversation' ? st.view.id : undefined));

/** Something short in this window ("Copied the link"). */
export function useSay(): (text: string, level?: 'info' | 'success' | 'warn' | 'error') => void {
  const { client } = useBeluga();
  return (text, level = 'success') => client.store.dispatch({ type: 'toast', text, level });
}

export const errorText = message;
