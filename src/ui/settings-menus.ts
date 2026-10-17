import type { AppState } from '../core/store.js';
import type { Settings } from '../core/settings.js';
import { TRUST_INFO, defaultTrust, trustOf } from '../core/trust.js';
import { THEME_LABELS } from './theme.js';
import type { MenuOption, MenuSpec } from './menus.js';

export type SettingsSection = 'claude' | 'notify' | 'workspaces' | 'people' | 'display' | 'buttons';

const onOff = (on: boolean): string => (on ? 'On' : 'Off');
const sw = '  ·  Enter to switch';
const back: MenuOption = { id: 'set-back', label: '‹ Back', hint: 'Esc' };

export const TUNNEL_LABELS: Readonly<Record<Settings['tunnel'], string>> = {
  auto: 'Direct (peer-to-peer), Cloudflare as backup',
  p2p: 'Direct (peer-to-peer) only',
  cloudflared: 'Cloudflare only',
  ngrok: 'ngrok',
  none: 'Local network only',
};
export const TUNNEL_ORDER: readonly Settings['tunnel'][] = ['auto', 'p2p', 'cloudflared', 'ngrok', 'none'];

const SUBAGENT_LABELS = { full: 'Every step', compact: 'One line each', hidden: 'Hidden' } as const;

/** Workspace buttons you can hide from the top bar (id → label). */
export const HIDEABLE_BUTTONS: ReadonlyArray<readonly [string, string]> = [
  ['run', 'Run'],
  ['terminal', 'Terminal'],
  ['review_claude', 'Review'],
  ['commit', 'Commit'],
  ['pr', 'PR'],
  ['merge', 'Merge'],
  ['handoff', 'Hand off'],
  ['compact', 'Compact'],
  ['fork', 'Fork'],
  ['finder', 'Finder'],
  ['archive', 'Archive'],
  ['share', 'Share'],
];

export function modelLabel(state: AppState, value: string | undefined): string {
  if (!value) return 'Default';
  return state.models.find((m) => m.value === value)?.label ?? value;
}

/** Everything you can change, grouped so nothing is more than one click away. */
export function settingsMenu(state: AppState, section?: SettingsSection, extra: { prCustom?: boolean; remembered?: Settings['people'] } = {}): MenuSpec {
  const p = state.prefs;
  switch (section) {
    case 'claude':
      return {
        title: 'Settings › Claude',
        intro: ['How your Claude works, for you and for the people you let use it.', ''],
        options: [
          { id: 'set-model', label: 'Model for new conversations', hint: `${modelLabel(state, p.model)}  ·  Enter to choose (each chat can pick its own)` },
          { id: 'set-effort', label: 'Thinking effort', hint: `${p.effort ?? 'Default'}${sw}` },
          { id: 'set-self-approval', label: 'My Claude asks before commands', hint: `${p.selfApproval === 'ask' ? 'Yes (safer)' : 'No, it just works (secrets stay blocked)'}${sw}` },
          { id: 'set-pr-prompt', label: 'Pull request instructions', hint: `${extra.prCustom ? 'Customized' : 'Built-in'}  ·  Enter to edit in your editor` },
          ...(extra.prCustom ? [{ id: 'set-pr-reset', label: 'Reset pull request instructions', hint: 'back to the built-in ones' }] : []),
          { id: 'set-templates', label: 'Templates…', hint: `${state.templates.length} ways to start a task` },
          back,
        ],
      };
    case 'notify':
      return {
        title: 'Settings › Notifications',
        intro: ['klaud tells you when something needs you, on the desktop and in the inbox (top right).', 'Nothing is announced about the conversation you are looking at.', ''],
        options: [
          { id: 'n-desktop', label: 'Desktop notifications', hint: `${onOff(p.notify.desktop)}${sw}` },
          { id: 'n-sound', label: 'Sound', hint: `${onOff(p.notify.sound)}${sw}` },
          { id: 'n-done', label: 'Claude finished', hint: `${onOff(p.notify.done)}${sw}` },
          { id: 'n-needsYou', label: 'Claude needs you', hint: `${onOff(p.notify.needsYou)}  ·  questions, plans, approvals` },
          { id: 'n-problems', label: 'Errors and merge conflicts', hint: `${onOff(p.notify.problems)}${sw}` },
          { id: 'n-people', label: 'People', hint: `${onOff(p.notify.people)}  ·  joins, invites, handoffs` },
          { id: 'n-pr', label: 'Pull requests', hint: `${onOff(p.notify.pr)}  ·  opened, checks passed or failed` },
          { id: 'n-test', label: 'Send a test notification', hint: '' },
          back,
        ],
      };
    case 'workspaces':
      return {
        title: 'Settings › Workspaces',
        intro: ['New worktrees, scripts, the terminal and the top bar.', ''],
        options: [
          { id: 'w-setup', label: 'Run setup in new worktrees', hint: `${onOff(p.autoSetup)}  ·  e.g. npm install (set per project in its ⋯ menu)` },
          { id: 'w-friend', label: 'Friends may start work here', hint: `${p.friendWorktrees === 'ask' ? 'Yes, I approve each one' : 'No'}  ·  worktrees and handoffs from friends` },
          { id: 'w-shell', label: 'Terminal shell', hint: `${p.shell ?? process.env.SHELL ?? '/bin/zsh'}  ·  type a new one` },
          { id: 'w-buttons', label: 'Top bar buttons…', hint: p.hiddenButtons.length ? `${p.hiddenButtons.length} hidden` : 'all shown' },
          back,
        ],
      };
    case 'buttons':
      return {
        title: 'Settings › Top bar buttons',
        intro: ['Show only the workspace buttons you use. Hidden ones still work as /commands.', ''],
        options: [...HIDEABLE_BUTTONS.map(([id, label]) => ({ id: `btn:${id}`, label, hint: `${p.hiddenButtons.includes(id) ? '○ hidden' : '◉ shown'}${sw}` })), { id: 'set-back-workspaces', label: '‹ Back', hint: 'Esc' }],
      };
    case 'people': {
      const others = state.peers.filter((x) => x.peerId !== state.self?.peerId);
      const away = Object.entries(extra.remembered ?? {}).filter(([id]) => !state.peers.some((x) => x.peerId === id));
      return {
        title: 'Settings › People & permissions',
        intro: [
          'Pick how much you trust each person. Click someone to change it.',
          `  ${TRUST_INFO.ask.label}: ${TRUST_INFO.ask.detail}`,
          `  ${TRUST_INFO.trusted.label}: ${TRUST_INFO.trusted.detail}`,
          `  ${TRUST_INFO.full.label}: ${TRUST_INFO.full.detail}`,
          '',
        ],
        options: [
          { id: 'p-default', label: 'New people start at', hint: `${TRUST_INFO[defaultTrust(state)].label}${sw}` },
          ...others.map((x) => ({ id: `p-person:${x.peerId}`, label: x.name, hint: `${TRUST_INFO[trustOf(state, x.peerId)].label}  ·  Enter to change` })),
          ...away.map(([id, x]) => ({ id: `p-forget:${id}`, label: `${x.name} (not here)`, hint: `${TRUST_INFO[x.trust].label}  ·  Enter to forget` })),
          { id: 'set-tunnel', label: 'How friends connect', hint: `${TUNNEL_LABELS[p.tunnel]}  ·  applies next start` },
          back,
        ],
      };
    }
    case 'display':
      return {
        title: 'Settings › Display',
        intro: [''],
        options: [
          { id: 'set-mouse', label: 'Mouse clicks', hint: `${p.mouse ? 'On' : 'Off (keeps native text selection)'}${sw}` },
          { id: 'd-context', label: 'Context meter', hint: `${onOff(p.contextMeter)}  ·  how full each conversation is` },
          { id: 'd-subagents', label: 'Sub-agent detail', hint: `${SUBAGENT_LABELS[p.subagents]}${sw}` },
          { id: 'size-in', label: 'Make text bigger', hint: 'Option+↑ (Alt+↑) anywhere' },
          { id: 'size-out', label: 'Make text smaller', hint: 'Option+↓ (Alt+↓) anywhere' },
          { id: 'size-reset', label: 'Normal text size', hint: '' },
          back,
        ],
      };
    default: {
      const n = p.notify;
      const others = state.peers.filter((x) => x.peerId !== state.self?.peerId).length;
      return {
        title: 'Settings',
        intro: ['Saved to ~/.klaud/settings.json and used every time you run klaud.', ''],
        options: [
          { id: 'set-name', label: 'Your name', hint: `${state.self?.name ?? '–'}  ·  type a new one` },
          { id: 'set-theme', label: 'Color theme', hint: `${THEME_LABELS[p.theme]}${sw}` },
          { id: 'sec:people', label: 'People & permissions ›', hint: `new people: ${TRUST_INFO[defaultTrust(state)].short}${others ? ` · ${others} here` : ''}` },
          { id: 'sec:notify', label: 'Notifications ›', hint: n.desktop ? `desktop on${n.sound ? ' · sound' : ''}` : 'desktop off · inbox only' },
          { id: 'sec:claude', label: 'Claude ›', hint: `${modelLabel(state, p.model)} · PR instructions · templates` },
          { id: 'sec:workspaces', label: 'Workspaces ›', hint: `setup ${p.autoSetup ? 'on' : 'off'} · terminal · top bar` },
          { id: 'sec:display', label: 'Display ›', hint: 'mouse, text size, context meter, sub-agents' },
          { id: 'close', label: 'Done', hint: 'Esc' },
        ],
      };
    }
  }
}

/** Pick the model for one conversation (or the default for new ones). */
export function modelMenu(state: AppState, current: string | undefined, forWhat: string): MenuSpec {
  return {
    title: `Model for ${forWhat}`,
    intro: ['Each conversation can use its own model. It applies from the next message.', ''],
    options: [
      ...state.models.map((m) => ({ id: `model:${m.value}`, label: `${(current ?? '') === m.value ? '◉' : '○'} ${m.label}`, hint: m.description })),
      { id: 'close', label: 'Cancel', hint: 'Esc' },
    ],
  };
}

const AGO = (ts: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
};

/** Everything that happened while you were elsewhere, newest first. Click one to go there. */
export function inboxMenu(state: AppState, now = Date.now()): MenuSpec {
  const list = state.inbox.slice(0, 30);
  return {
    title: 'Inbox',
    intro: [list.length ? `${state.inbox.filter((x) => !x.read).length} new · click one to open it` : 'Nothing yet. klaud lists what happens in other workspaces here.', ''],
    options: [
      ...list.map((x) => ({ id: `notice:${x.id}`, label: `${x.read ? '  ' : '● '}${x.title}`, hint: `${AGO(x.ts, now)}${x.body ? `  ·  ${x.body}` : ''}` })),
      ...(list.length ? [{ id: 'inbox-read', label: 'Mark all as read', hint: '' }, { id: 'inbox-clear', label: 'Clear the inbox', hint: '' }] : []),
      { id: 'sec:notify', label: 'Notification settings…', hint: '' },
      { id: 'close', label: 'Close', hint: 'Esc' },
    ],
  };
}
