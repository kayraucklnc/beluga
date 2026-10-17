import type { AppState } from '../core/store.js';
import { THEME_LABELS } from './theme.js';
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

export type MenuKind =
  | { readonly kind: 'welcome' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'person'; readonly index: number }
  | { readonly kind: 'confirm'; readonly action: 'archive' | 'delete'; readonly id: string };

/** "Are you sure?" for archive and delete, explaining exactly what happens. */
export function confirmMenu(state: AppState, action: 'archive' | 'delete', id: string): MenuSpec | undefined {
  const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === id);
  if (!ws) return undefined;
  const changed = ws.status?.changed ?? 0;
  const env = state.envChanges[id] ?? [];
  const envLines = env.length
    ? [
        '',
        'Env changes in this worktree (not in the main folder):',
        ...env.map((c) =>
          c.binary
            ? `  ${c.file}  (file differs)`
            : `  ${c.file}  ${[c.added.length ? `+${c.added.join(', +')}` : '', c.changed.length ? `~${c.changed.join(', ~')}` : '', c.removed.length ? `−${c.removed.join(', −')}` : ''].filter(Boolean).join('  ')}`,
        ),
      ]
    : [];
  const envOption = env.length ? [{ id: `confirm-${action}-env`, label: `Copy env changes to the main folder, then ${action}`, hint: 'keeps your new keys' }] : [];
  if (action === 'archive') {
    return {
      title: `Archive ${ws.name}?`,
      intro: [
        ws.kind === 'worktree'
          ? 'The worktree folder is removed. Its branch and the Claude conversation are kept, so you can restore it later.'
          : 'The chat is hidden from the sidebar. You can restore it from Overview.',
        ...(changed ? [`${changed} file(s) have uncommitted changes.`] : []),
        ...envLines,
      ],
      options: [
        ...envOption,
        ...(changed ? [{ id: 'confirm-commit-archive', label: 'Commit changes, then archive', hint: 'recommended' }] : []),
        { id: changed ? 'confirm-archive-force' : 'confirm-archive', label: changed ? 'Archive and discard uncommitted changes' : 'Archive', hint: '' },
        { id: 'close', label: 'Cancel', hint: 'Esc' },
      ],
    };
  }
  return {
    title: `Delete ${ws.name}?`,
    intro: [
      ws.kind === 'worktree' && !ws.external
        ? `This deletes the worktree folder, the branch ${ws.branch ?? ''} and the conversation. This can't be undone.`
        : "This removes it from klaude and deletes the conversation. This can't be undone.",
      ...envLines,
    ],
    options: [
        ...envOption,
      { id: 'confirm-delete', label: 'Delete permanently', hint: '' },
      { id: 'close', label: 'Cancel', hint: 'Esc' },
    ],
  };
}

const POLICY_LABELS = { ask: 'Ask me each time', auto: 'Everyone, without asking', deny: 'Nobody (private)' } as const;
const TUNNEL_LABELS = { auto: 'Cloudflare, automatic', cloudflared: 'Cloudflare', ngrok: 'ngrok', none: 'Local network only' } as const;

/** Everything you can change, with its current value. Enter/click changes it on the spot. */
export function settingsMenu(state: AppState): MenuSpec {
  return {
    title: 'Settings',
    intro: ['Saved to ~/.klaude/settings.json and used every time you run klaude.', ''],
    options: [
      { id: 'set-name', label: 'Your name', hint: `${state.self?.name ?? '–'}  ·  type a new one` },
      { id: 'set-theme', label: 'Color theme', hint: `${THEME_LABELS[state.prefs.theme]}  ·  Enter to switch` },
      { id: 'set-policy', label: 'Who can use my Claude', hint: `${POLICY_LABELS[state.policy]}  ·  Enter to switch` },
      {
        id: 'set-self-approval',
        label: 'My Claude asks before commands',
        hint: `${state.prefs.selfApproval === 'ask' ? 'Yes (safer)' : 'No, it just works (secrets stay blocked)'}  ·  Enter to switch`,
      },
      { id: 'set-mouse', label: 'Mouse clicks', hint: `${state.prefs.mouse ? 'On' : 'Off (keeps native text selection)'}  ·  Enter to switch` },
      { id: 'set-tunnel', label: 'Remote access', hint: `${TUNNEL_LABELS[state.prefs.tunnel]}  ·  applies next start` },
      { id: 'size-in', label: 'Make text bigger', hint: 'Option+↑ (Alt+↑) anywhere' },
      { id: 'size-out', label: 'Make text smaller', hint: 'Option+↓ (Alt+↓) anywhere' },
      { id: 'size-reset', label: 'Normal text size', hint: '' },
      { id: 'close', label: 'Done', hint: 'Esc' },
    ],
  };
}

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
        { id: 'settings', label: 'Settings', hint: 'name, theme, mouse, remote access' },
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
        state.fullTrust.includes(peer.peerId)
          ? { id: 'unfulltrust', label: `Stop fully trusting ${peer.name}`, hint: 'now: runs everything without asking' }
          : { id: 'fulltrust', label: `Fully trust ${peer.name}`, hint: 'requests and actions run without asking' },
        state.trusted.includes(peer.peerId)
          ? { id: 'untrust', label: `Ask before ${peer.name} uses my Claude` }
          : { id: 'trust', label: `Let ${peer.name} use my Claude without asking`, hint: 'still asks before commands' },
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
  if (menu.kind === 'welcome') return welcomeMenu(state);
  if (menu.kind === 'settings') return settingsMenu(state);
  if (menu.kind === 'confirm') return confirmMenu(state, menu.action, menu.id);
  return personMenu(state, menu.index);
}
