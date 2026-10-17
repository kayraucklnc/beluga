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

export function actionButtons(focus: Focus, state: AppState, suggesting: boolean, viewer: ViewerMode = { full: false, raw: false }): ActionButton[] {
  if (suggesting) {
    return [
      { id: 'accept', text: 'Accept', key: 'Tab' },
      { id: 'hide', text: 'Hide', key: 'Esc' },
    ];
  }
  switch (focus) {
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
        { id: 'review-claude', text: 'Ask Claude to review', key: '' },
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
      if (state.view.kind === 'workspace') {
        return [
          { id: 'actions', text: 'Actions', key: 'Tab' },
          { id: 'review', text: 'Diff', key: '' },
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
          { id: 'invite', text: state.invite ? 'Copy invite' : 'Invite friends', key: '' },
          { id: 'settings', text: 'Settings', key: '' },
          { id: 'help', text: 'Help', key: '' },
        ];
      }
      return [
        { id: 'ask', text: 'Ask Claude', key: '@' },
        { id: 'commands', text: 'Commands', key: '/' },
        { id: 'projects', text: 'Projects', key: 'Tab' },
        { id: 'invite', text: state.invite ? 'Copy invite' : 'Invite friends', key: '' },
        { id: 'share-folder', text: 'Share', key: '' },
        { id: 'clear', text: 'Clear', key: '' },
        { id: 'settings', text: 'Settings', key: '' },
        { id: 'help', text: 'Help', key: '' },
      ];
  }
}
