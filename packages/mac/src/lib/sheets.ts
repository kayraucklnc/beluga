import { useSyncExternalStore } from 'react';
import type { MenuKind } from '@klaud/ui/menus.js';

/**
 * Sheets and alerts this window opens for things the terminal UI asks in its message box (a
 * name for a fork, a command for a friend's computer…) or doesn't ask at all (hiding a
 * project). The terminal UI types; here you get a proper form.
 */
export type NativeSheet =
  /** Copy a workspace under a new name. */
  | { readonly kind: 'fork'; readonly wsId: string }
  /** A command to run on a friend's computer (`peerId` unset: pick who). */
  | { readonly kind: 'peer_run'; readonly peerId?: string }
  /** A new template (Name, Prompt, Plan first). */
  | { readonly kind: 'template' }
  /** A worktree on a friend's computer, with the project already picked. */
  | { readonly kind: 'remote'; readonly peerId: string; readonly project?: string }
  /** "Are you sure?" before a menu option that removes something; Confirm picks it. */
  | { readonly kind: 'confirm_option'; readonly menu: MenuKind; readonly index: number; readonly id: string }
  /** "Are you sure?" for something that isn't a menu option (from the palette). */
  | { readonly kind: 'confirm'; readonly title: string; readonly message: string; readonly confirm: string; readonly destructive?: boolean; readonly run: () => void };

type Listener = () => void;

let current: NativeSheet | undefined;
const listeners = new Set<Listener>();

export function openSheet(sheet: NativeSheet): void {
  current = sheet;
  for (const l of [...listeners]) l();
}

export function closeSheet(): void {
  if (!current) return;
  current = undefined;
  for (const l of [...listeners]) l();
}

const subscribe = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useSheet(): NativeSheet | undefined {
  return useSyncExternalStore(subscribe, () => current);
}
