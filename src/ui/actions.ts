import type { AppState } from '../core/store.js';
import type { Focus } from './keymap.js';

export interface ActionButton {
  readonly id: string;
  readonly text: string;
  /** Keyboard equivalent, shown dimmed next to the text. */
  readonly key: string;
}

export const buttonLabel = (b: ActionButton): string => (b.key ? `${b.text} ${b.key}` : b.text);

/** Context-aware buttons for the bottom bar: always show what you can do right now. */
export interface ViewerMode {
  readonly full: boolean;
  readonly raw: boolean;
}

/** What the composer is up to, for the queue / send-now buttons. */
export interface ComposeState {
  /** There's a draft that would go to your Claude. */
  readonly typing: boolean;
  /** Your Claude is working in this conversation (Enter would queue). */
  readonly busy: boolean;
  /** Your messages waiting their turn in this conversation. */
  readonly queued: number;
}

/** While your Claude works: queue the draft or send it now; and run or drop what's waiting. */
function composeButtons(c: ComposeState | undefined): ActionButton[] {
  if (!c) return [];
  return [
    ...(c.typing && c.busy
      ? [
          { id: 'queue', text: 'Queue', key: '↵' },
          { id: 'send-now', text: 'Send now', key: '⌥↵' },
        ]
      : []),
    ...(c.queued
      ? [
          { id: 'queued-now', text: c.queued > 1 ? `Run next queued now (${c.queued})` : 'Run queued now', key: '' },
          { id: 'queued-cancel', text: 'Cancel queued', key: '' },
        ]
      : []),
  ];
}

/** Hosting: the Invite flow (one project or everything). In someone else's room: pass on its link. */
const inviteLabel = (state: AppState): string => (state.self?.host ? 'Invite…' : state.invite ? 'Copy invite' : 'Invite friends');

export function actionButtons(focus: Focus, state: AppState, suggesting: boolean, viewer: ViewerMode = { full: false, raw: false }, compose?: ComposeState): ActionButton[] {
  if (suggesting) {
    return [
      { id: 'accept', text: 'Accept', key: 'Tab' },
      { id: 'hide', text: 'Hide', key: 'Esc' },
    ];
  }
  switch (focus) {
    case 'terminal':
      return [
        { id: 'chat', text: 'Leave the terminal', key: 'Ctrl+]' },
        { id: 'scroll', text: 'Scroll back', key: 'wheel' },
      ];
    case 'header':
      return [
        { id: 'chat', text: 'Use the buttons', key: '↵' },
        { id: 'projects', text: 'Next area', key: 'Tab' },
        { id: 'chat', text: 'Back to chat', key: 'Esc' },
      ];
    case 'projects':
      return [
        { id: 'open-project-item', text: 'Open', key: '↵' },
        { id: 'overview', text: 'Overview', key: '' },
        { id: 'chat', text: 'Back to chat', key: 'Esc' },
      ];
    case 'main':
      if (state.view.kind === 'overview') {
        return [
          { id: 'scroll', text: 'Scroll', key: 'PgUp PgDn / wheel' },
          { id: 'chat', text: 'Back', key: 'Esc' },
        ];
      }
      return [
        { id: 'scroll', text: 'Choose file', key: '↑↓' },
        { id: 'scroll', text: 'Scroll diff', key: 'PgUp PgDn' },
        // Someone else's workspace: their diff is read-only.
        ...(state.view.kind === 'shared' ? [] : [{ id: 'review-claude', text: 'Ask Claude to review', key: '' }]),
        { id: 'chat', text: 'Back', key: 'Esc' },
      ];
    case 'people':
      return [
        { id: 'menu', text: 'Actions', key: '↵' },
        { id: 'chat', text: 'Back to chat', key: 'Esc' },
      ];
    case 'files': {
      const row = state.browser.rows[state.browser.cursor];
      const isFile = row !== undefined && row.target !== 'up' && !row.dir;
      return [
        { id: 'open', text: isFile ? 'Open' : 'Enter folder', key: '↵' },
        ...(isFile ? [{ id: 'download', text: 'Download', key: 'd' }] : []),
        ...(state.browser.at ? [{ id: 'up', text: 'Back', key: '←' }] : []),
        { id: 'chat', text: 'Chat', key: 'Esc' },
      ];
    }
    case 'viewer':
      // File controls live on the viewer itself; the bar only explains movement.
      return [
        { id: 'scroll', text: 'Scroll', key: '↑↓ PgUp PgDn' },
        { id: 'chat', text: viewer.full ? 'Leave fullscreen' : 'Back to chat', key: 'Esc' },
      ];
    default:
      if (state.view.kind === 'search') {
        return [
          { id: 'scroll', text: 'Choose', key: '↑↓' },
          { id: 'open-hit', text: 'Open', key: '↵' },
          { id: 'overview', text: 'Overview', key: '' },
          { id: 'help', text: 'Help', key: '' },
        ];
      }
      if (state.view.kind === 'usage') {
        return [
          { id: 'refresh-usage', text: 'Measure again', key: '' },
          { id: 'overview', text: 'Overview', key: '' },
          { id: 'settings', text: 'Settings', key: '' },
          { id: 'help', text: 'Help', key: '' },
        ];
      }
      if (state.view.kind === 'workspace') {
        return [
          ...composeButtons(compose),
          { id: 'actions', text: 'Actions', key: 'Tab' },
          { id: 'review', text: 'Diff', key: '' },
          { id: 'terminal', text: 'Terminal', key: '' },
          { id: 'templates', text: 'Templates', key: '' },
          { id: 'overview', text: 'Overview', key: '' },
          { id: 'clear', text: 'Clear', key: '' },
          { id: 'settings', text: 'Settings', key: '' },
          { id: 'help', text: 'Help', key: '' },
        ];
      }
      if (state.view.kind === 'files') {
        return [
          { id: 'share-folder', text: '+ Share a folder', key: '' },
          { id: 'projects', text: 'Projects', key: 'Tab' },
          { id: 'invite', text: inviteLabel(state), key: '' },
          { id: 'settings', text: 'Settings', key: '' },
          { id: 'help', text: 'Help', key: '' },
        ];
      }
      return [
        ...composeButtons(compose),
        { id: 'ask', text: 'Ask Claude', key: '@' },
        { id: 'commands', text: 'Commands', key: '/' },
        ...(state.view.kind === 'draft' || state.view.kind === 'draft_worktree' ? [{ id: 'templates', text: 'Templates', key: '' }] : []),
        { id: 'projects', text: 'Projects', key: 'Tab' },
        { id: 'invite', text: inviteLabel(state), key: '' },
        { id: 'share-folder', text: 'Share', key: '' },
        { id: 'clear', text: 'Clear', key: '' },
        { id: 'settings', text: 'Settings', key: '' },
        { id: 'help', text: 'Help', key: '' },
      ];
  }
}
