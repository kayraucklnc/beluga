import { useSyncExternalStore } from 'react';
import { DEFAULT_LAYOUT, DRAWER_DEFAULT, PANEL_DEFAULT, PANES_DEFAULT, type PanelLayout, type PanelTab, SPLIT_DEFAULT, type TerminalPlace, migratePrefs, normalizeLayout } from './panel-model.js';

/**
 * How this window looks and behaves: kept on this Mac only (Beluga's shared settings, like the
 * model or notifications, live in the core and apply to every screen).
 */
export interface UiPrefs {
  readonly appearance: 'system' | 'light' | 'dark';
  readonly accent: Accent;
  /** Text size: 12–16 px for body text. */
  readonly textSize: number;
  readonly density: 'compact' | 'comfortable';
  /** How wide the conversation can get (characters, roughly). */
  readonly chatWidth: 'narrow' | 'wide' | 'full';
  /** The right panel (Changes, Files, Terminal, Info) is showing. */
  readonly inspector: boolean;
  /** How wide the right panel is (px; never more than 60% of the window). */
  readonly panelWidth: number;
  /** The tab you last picked in the panel, per workspace ('ws:<id>') and for everything else ('app'); the bottom pane's end in '|bottom'. */
  readonly panelTabs: Readonly<Record<string, PanelTab>>;
  /** Which tabs are in the panel's top pane and which in its bottom one (drag a tab across to change it). */
  readonly panelLayout: PanelLayout;
  /** How much of the panel's height the top pane takes (0.18–0.75). */
  readonly paneSplit: number;
  /** The bottom pane is open (closed, it's just its tabs along the bottom). */
  readonly bottomOpen: boolean;
  /** In the Changes and Files tabs: how much of the height the list keeps above a diff or a preview (0.18–0.75). */
  readonly panelSplit: number;
  readonly sidebar: boolean;
  readonly sidebarWidth: number;
  /** Sidebar sections you've folded. */
  readonly folded: readonly string[];
  /** Projects you unfolded in the sidebar (by id): the rest start folded. */
  readonly openProjects: readonly string[];
  /** The sidebar's Unread section: conversations that finished or need you, at the top (only while there are some). */
  readonly unreadSection: boolean;
  /** Enter sends and Shift+Enter makes a new line, or the other way round with ⌘Enter. */
  readonly sendWith: 'enter' | 'cmd-enter';
  readonly timestamps: boolean;
  /** A finished answer's steps: folded away once Claude answers (one click shows them), or left showing. */
  readonly doneSteps: 'fold' | 'show';
  readonly reduceMotion: boolean;
  /** Where ⌘J (and Run) show the terminal: the drawer under the chat, or the right panel's Terminal tab. */
  readonly termIn: TerminalPlace;
  /** The terminal drawer under the chat is open. */
  readonly drawer: boolean;
  /** How much of the window's height the drawer takes (0.18–0.75). */
  readonly drawerSize: number;
  /** The terminal's font family ('' : the system's monospace, SF Mono). */
  readonly termFont: string;
  readonly termFontSize: number;
  readonly termLineHeight: number;
  readonly termCursor: 'block' | 'bar' | 'underline';
  readonly termCursorBlink: boolean;
  /** Lines each terminal keeps to scroll back through. */
  readonly termScrollback: number;
  /** A file open full size wraps its long lines (instead of scrolling sideways). */
  readonly readerWrap: boolean;
  /** Chats open as tabs above the conversation (`dm:<peerId>` / `group:<id>`; the main channel is always first). */
  readonly chatTabs: readonly string[];
  /** A changed file shows its diff, or the file as itself (Markdown formatted). Pictures and PDFs always as themselves. */
  readonly changeLook: 'diff' | 'file';
  /** The panel has a Scratch tab: the workspace's .beluga/scratch/ folder, live. */
  readonly scratchTab: boolean;
  /** The icon you picked for each sidebar group (by name; unset: a folder). */
  readonly groupIcons: Readonly<Record<string, string>>;
  /** Plans (by id) whose task chats you asked to see in the sidebar under them (a plan is one row otherwise). */
  readonly planTaskChats: readonly string[];
}

export const ACCENTS = {
  system: 'AccentColor',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  rose: '#e11d48',
  amber: '#d97706',
  emerald: '#059669',
  teal: '#0d9488',
  graphite: '#6b7280',
} as const;
export type Accent = keyof typeof ACCENTS;

export const DEFAULT_PREFS: UiPrefs = {
  appearance: 'system',
  accent: 'system',
  textSize: 13,
  density: 'comfortable',
  chatWidth: 'wide',
  inspector: true,
  panelWidth: PANEL_DEFAULT,
  panelTabs: {},
  panelLayout: DEFAULT_LAYOUT,
  paneSplit: PANES_DEFAULT,
  bottomOpen: true,
  panelSplit: SPLIT_DEFAULT,
  sidebar: true,
  sidebarWidth: 248,
  folded: [],
  openProjects: [],
  unreadSection: true,
  sendWith: 'enter',
  timestamps: true,
  doneSteps: 'fold',
  reduceMotion: false,
  termIn: 'panel',
  drawer: false,
  drawerSize: DRAWER_DEFAULT,
  termFont: '',
  termFontSize: 12.5,
  termLineHeight: 1.18,
  termCursor: 'block',
  termCursorBlink: true,
  termScrollback: 5000,
  readerWrap: false,
  chatTabs: [],
  changeLook: 'diff',
  scratchTab: true,
  groupIcons: {},
  planTaskChats: [],
};

const KEY = 'beluga.prefs.v1';
const listeners = new Set<() => void>();

function load(): UiPrefs {
  try {
    // Older versions docked the terminal beside or under the chat: see migratePrefs.
    const saved = { ...DEFAULT_PREFS, ...(migratePrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>) as Partial<UiPrefs>) };
    return { ...saved, panelLayout: normalizeLayout(saved.panelLayout) };
  } catch {
    return DEFAULT_PREFS;
  }
}

let current = load();

export const getPrefs = (): UiPrefs => current;

export function setPrefs(patch: Partial<UiPrefs>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage full or unavailable: the change still applies until the app quits
  }
  apply(current);
  for (const l of [...listeners]) l();
}

export function usePrefs(): UiPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    getPrefs,
  );
}

const dark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Put the preferences on the document (CSS variables and data attributes do the rest). */
export function apply(p: UiPrefs = current): void {
  const root = document.documentElement;
  root.dataset.theme = p.appearance === 'system' ? (dark() ? 'dark' : 'light') : p.appearance;
  root.dataset.density = p.density;
  root.dataset.motion = p.reduceMotion ? 'reduce' : 'full';
  root.style.setProperty('--accent', ACCENTS[p.accent]);
  root.style.setProperty('--text-size', `${p.textSize}px`);
  root.style.setProperty('--sidebar-w', `${p.sidebarWidth}px`);
  root.style.setProperty('--panel-w', `${p.panelWidth}px`);
  root.style.setProperty('--chat-max', p.chatWidth === 'narrow' ? '42rem' : p.chatWidth === 'wide' ? '60rem' : '100%');
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply());

/** ⌘+ / ⌘- / ⌘0: the window's text size. */
export function zoom(dir: 'in' | 'out' | 'reset'): { ok: boolean; message: string } {
  const size = dir === 'reset' ? DEFAULT_PREFS.textSize : Math.min(17, Math.max(11, current.textSize + (dir === 'in' ? 1 : -1)));
  setPrefs({ textSize: size });
  return { ok: true, message: `Text size ${size}` };
}
