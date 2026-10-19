import { type ReactElement, type ReactNode, useCallback, useRef } from 'react';
import { Icon, type IconName } from './Icon.js';
import type { SelectEntryBase, SelectOptionBase } from './select-model.js';

/** One choice in a Select. */
export interface SelectOption<T extends string> extends SelectOptionBase<T> {
  /** Before the label, in the menu and on the button: an icon's name, or an element (an avatar, a project icon). */
  readonly icon?: IconName | ReactElement;
  /** At the right of the row in the menu ("default", a count). */
  readonly badge?: ReactNode;
  /** What the button shows when the label is too long for it. */
  readonly short?: string;
}

export type SelectSection<T extends string> = { readonly section: string; readonly options: readonly SelectOption<T>[] };
export type SelectEntry<T extends string> = SelectEntryBase<SelectOption<T>>;

/** How long a pause starts a new type-ahead search. */
const TYPEAHEAD_PAUSE = 700;

/** Letters typed close together, for type-ahead (they reset after a pause). */
export function useTypeahead(): (key: string) => string {
  const typed = useRef({ text: '', at: 0 });
  return useCallback((key: string) => {
    const now = Date.now();
    typed.current = { text: now - typed.current.at > TYPEAHEAD_PAUSE ? key : typed.current.text + key, at: now };
    return typed.current.text;
  }, []);
}

/** An option's icon, by name or as given. */
export function OptionIcon({ icon, size = 13 }: { icon: IconName | ReactElement; size?: number }) {
  return typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon;
}
