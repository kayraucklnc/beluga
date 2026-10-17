import type { AppState } from '../core/store.js';
import { describeWindow } from '../agent/usage.js';
import type { Usage } from '../protocol.js';

function usageLines(usage: Usage | undefined): string[] {
  if (!usage) return [];
  return [`Claude usage${usage.plan ? ` (${usage.plan})` : ''}:  5-hour ${describeWindow(usage.fiveHour)}   ·   week ${describeWindow(usage.week)}`];
}

export interface MenuOption {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
}

export interface MenuSpec {
  readonly title: string;
  readonly intro: readonly string[];
  readonly options: readonly MenuOption[];
}

export type MenuKind = { readonly kind: 'welcome' } | { readonly kind: 'person'; readonly index: number };

/** First screen after joining: decide whether friends may use your Claude. */
export function welcomeMenu(state: AppState): MenuSpec {
  const others = state.peers.filter((p) => p.peerId !== state.self?.peerId).map((p) => p.name);
  const who = others.length ? `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} here.` : 'Nobody else is here yet.';
  return {
    title: `Welcome to ${state.room}`,
    intro: [
      `You're ${state.self?.name ?? 'connected'}. ${who}`,
      '',
      'Friends can ask your Claude to help. It runs on this computer with your Claude',
      "subscription, inside the folders you shared. You'll always see what they ask.",
      '',
      'Can people in this room use your Claude?',
    ],
    options: [
      { id: 'share-ask', label: 'Ask me each time', hint: 'recommended: approve every request' },
      { id: 'share-auto', label: 'Yes, everyone can use it', hint: 'requests run without asking' },
      { id: 'share-deny', label: 'No, keep my Claude private', hint: 'only you can use it' },
    ],
  };
}

/** Actions for a person in the People panel. */
export function personMenu(state: AppState, index: number): MenuSpec | undefined {
  const peer = state.peers[index];
  if (!peer) return undefined;
  const isSelf = peer.peerId === state.self?.peerId;
  const share = peer.shares[0];
  const options: MenuOption[] = isSelf
    ? [
        { id: 'ask-self', label: 'Ask my Claude', hint: 'start a message with @claude' },
        ...(state.invite ? [{ id: 'invite', label: 'Copy invite link', hint: 'bring more friends' }] : []),
        { id: 'sharing', label: 'Change who can use my Claude', hint: `now: ${state.policy}` },
      ]
    : [
        ...(peer.agent ? [{ id: 'ask', label: `Ask ${peer.name}'s Claude`, hint: `runs on ${peer.name}'s computer` }] : []),
        state.access[peer.peerId] === 'full'
          ? { id: 'access-folder', label: `Limit ${peer.name} to my shared folders`, hint: 'now: whole computer' }
          : { id: 'access-full', label: `Give ${peer.name} access to my whole computer`, hint: 'now: shared folders only' },
        state.follow === peer.peerId
          ? { id: 'unfollow', label: `Stop following ${peer.name}` }
          : { id: 'follow', label: `Follow ${peer.name}`, hint: 'see the files they and their Claude open' },
        ...(share ? [{ id: 'browse', label: `Browse ${peer.name}'s files`, hint: `${share.name}${share.writable ? '' : ' (read-only)'}` }] : []),
        state.trusted.includes(peer.peerId)
          ? { id: 'untrust', label: `Ask before ${peer.name} uses my Claude` }
          : { id: 'trust', label: `Let ${peer.name} use my Claude without asking`, hint: 'this session only' },
      ];
  const about = isSelf ? 'What would you like to do?' : `${peer.agent ? 'Claude is on' : 'No Claude'} · shares ${peer.shares.map((s) => s.name).join(', ') || 'nothing'}`;
  const access = isSelf
    ? []
    : [
        state.access[peer.peerId] === 'full'
          ? `When ${peer.name} asks your Claude, it can read anything on this computer (secrets stay blocked).`
          : `When ${peer.name} asks your Claude, it can only use your shared folders.`,
      ];
  return { title: isSelf ? `${peer.name} (you)` : peer.name, intro: [about, ...usageLines(peer.usage), ...access], options };
}

export function menuSpec(state: AppState, menu: MenuKind): MenuSpec | undefined {
  return menu.kind === 'welcome' ? welcomeMenu(state) : personMenu(state, menu.index);
}
