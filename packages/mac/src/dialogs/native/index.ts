import type { ComponentType } from 'react';
import type { MenuKind } from '@klaud/ui/menus.js';

/**
 * Menus the Mac app shows its own way. The terminal UI draws every menu as a numbered list;
 * here a confirmation is an alert, an invite is a form, a person is a popover… A menu kind
 * listed here is drawn by its component instead of the generic list sheet (MenuSheet), with
 * the same menu spec and actions underneath where that fits.
 */
export interface NativeMenuProps<K extends MenuKind['kind'] = MenuKind['kind']> {
  readonly menu: Extract<MenuKind, { kind: K }>;
  /** Close it (what Esc and Cancel do). */
  readonly close: () => void;
}

export type NativeMenus = { readonly [K in MenuKind['kind']]?: ComponentType<NativeMenuProps<K>> };

export const NATIVE_MENUS: NativeMenus = {};
