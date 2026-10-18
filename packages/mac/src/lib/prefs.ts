import { useSyncExternalStore } from 'react';

/**
 * How this window looks and behaves: kept on this Mac only (klaud's shared settings, like the
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
  readonly inspector: boolean;
  readonly sidebar: boolean;
  readonly sidebarWidth: number;
  /** Sidebar sections you've folded. */
  readonly folded: readonly string[];
  /** Enter sends and Shift+Enter makes a new line, or the other way round with ⌘Enter. */
  readonly sendWith: 'enter' | 'cmd-enter';
  readonly timestamps: boolean;
  /** Show Claude's tool steps in the chat, or just its answers. */
  readonly steps: 'all' | 'summary';
  readonly reduceMotion: boolean;
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
  sidebar: true,
  sidebarWidth: 248,
  folded: [],
  sendWith: 'enter',
  timestamps: true,
  steps: 'all',
  reduceMotion: false,
};

const KEY = 'klaud.prefs.v1';
const listeners = new Set<() => void>();

function load(): UiPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<UiPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

let current = load();

export const getPrefs = (): UiPrefs => current;

export function setPrefs(patch: Partial<UiPrefs>): void {
  current = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(current));
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
  root.style.setProperty('--chat-max', p.chatWidth === 'narrow' ? '42rem' : p.chatWidth === 'wide' ? '60rem' : '100%');
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply());

/** ⌘+ / ⌘- / ⌘0: the window's text size. */
export function zoom(dir: 'in' | 'out' | 'reset'): { ok: boolean; message: string } {
  const size = dir === 'reset' ? DEFAULT_PREFS.textSize : Math.min(17, Math.max(11, current.textSize + (dir === 'in' ? 1 : -1)));
  setPrefs({ textSize: size });
  return { ok: true, message: `Text size ${size}` };
}
