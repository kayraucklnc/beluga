import { useSyncExternalStore } from 'react';

/** The look the window shows right now (Settings › Appearance, or the system's), following changes. */
export type DocTheme = 'light' | 'dark';

const read = (): DocTheme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function useDocTheme(): DocTheme {
  return useSyncExternalStore(subscribe, read, () => 'light');
}

/** Whether the window asks for less motion (Settings › Appearance or the system). */
export const reducedMotion = (): boolean => document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
