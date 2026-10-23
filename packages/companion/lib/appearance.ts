import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';
import { kv } from './kv';
import { type Scheme, setScheme } from './theme';

/** Light, dark, or follow the phone (the default). Settings › Advanced › Appearance. */
export type Choice = 'system' | Scheme;
const listeners = new Set<() => void>();
let choice: Choice = kv.get<Choice>('appearance') ?? 'system';

const resolve = (): Scheme => (choice === 'system' ? (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light') : choice);
let current: Scheme = resolve();
setScheme(current);

function update(): void {
  const next = resolve();
  if (next === current) return;
  current = next;
  setScheme(next);
  for (const fn of [...listeners]) fn();
}
Appearance.addChangeListener(update);

export const appearance = {
  get: (): Choice => choice,
  set(c: Choice): void {
    choice = c;
    kv.set('appearance', c);
    update();
    for (const fn of [...listeners]) fn();
  },
};

/** The scheme in use; the root remounts on change so every color is read afresh. */
export function useScheme(): Scheme {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => current,
  );
}
