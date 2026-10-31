import type { TermColors } from '../../../../src/terminal/import/look.js';
import type { TermThemePref } from './terminal-import-model.js';

/**
 * Colour themes to pick for the terminal (BLG-536), besides Beluga's own and one brought from
 * another terminal: the well-known ones, each with its light colours when it has some (they
 * follow Beluga's appearance). Kept in your settings exactly as an import is (`termTheme`).
 */

/** Where a picked theme says it came from (an import says its terminal's name). */
export const PRESET_FROM = 'Beluga';

const c = (background: string, foreground: string, cursor: string, selection: string, ansi: readonly string[]): TermColors => ({ background, foreground, cursor, selection, ansi });

export const TERMINAL_PRESETS: readonly TermThemePref[] = [
  {
    name: 'Dracula',
    from: PRESET_FROM,
    colors: c('#282a36', '#f8f8f2', '#f8f8f2', '#44475a', ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  },
  {
    name: 'Catppuccin',
    from: PRESET_FROM,
    colors: c('#1e1e2e', '#cdd6f4', '#f5e0dc', '#585b70', ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
    light: c('#eff1f5', '#4c4f69', '#dc8a78', '#acb0be', ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc']),
  },
  {
    name: 'Tokyo Night',
    from: PRESET_FROM,
    colors: c('#1a1b26', '#c0caf5', '#c0caf5', '#33467c', ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
    light: c('#e1e2e7', '#3760bf', '#3760bf', '#b6bfe2', ['#e9e9ed', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#6172b0', '#a1a6c5', '#f52a65', '#587539', '#8c6c3e', '#2e7de9', '#9854f1', '#007197', '#3760bf']),
  },
  {
    name: 'Nord',
    from: PRESET_FROM,
    colors: c('#2e3440', '#d8dee9', '#d8dee9', '#434c5e', ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  },
  {
    name: 'Gruvbox',
    from: PRESET_FROM,
    colors: c('#282828', '#ebdbb2', '#ebdbb2', '#504945', ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
    light: c('#fbf1c7', '#3c3836', '#3c3836', '#d5c4a1', ['#fbf1c7', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64', '#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#3c3836']),
  },
  {
    name: 'Rosé Pine',
    from: PRESET_FROM,
    colors: c('#191724', '#e0def4', '#524f67', '#403d52', ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4', '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4']),
    light: c('#faf4ed', '#575279', '#9893a5', '#dfdad9', ['#f2e9e1', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279', '#9893a5', '#b4637a', '#286983', '#ea9d34', '#56949f', '#907aa9', '#d7827e', '#575279']),
  },
  {
    name: 'Solarized',
    from: PRESET_FROM,
    colors: c('#002b36', '#839496', '#93a1a1', '#073642', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
    light: c('#fdf6e3', '#657b83', '#586e75', '#eee8d5', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  },
];

/** The preset a saved theme is (by name, from Beluga), or undefined for Beluga's own or an imported one. */
export const presetOf = (theme: TermThemePref | null): TermThemePref | undefined => (theme?.from === PRESET_FROM ? TERMINAL_PRESETS.find((p) => p.name === theme.name) : undefined);
