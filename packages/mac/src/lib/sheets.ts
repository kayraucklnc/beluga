import { useSyncExternalStore } from 'react';
import type { MenuKind } from '../../../../src/ui/menus.js';
import type { AskedWork } from './work-asked.js';

/**
 * Sheets and alerts this window opens for things the shared actions ask in the message box (a
 * name for a fork, a command for a friend's computer…) or don't ask at all (hiding a
 * project): here you get a proper form.
 */
export type NativeSheet =
  /** Copy a workspace under a new name. */
  | { readonly kind: 'fork'; readonly wsId: string }
  /** Carry a conversation (an ask chat in a main folder) into a new worktree and go on there. */
  | { readonly kind: 'continue_worktree'; readonly wsId: string }
  /** A command to run on a friend's computer (`peerId` unset: pick who). */
  | { readonly kind: 'peer_run'; readonly peerId?: string }
  /** A new template (Name, Prompt, Plan first). */
  | { readonly kind: 'template' }
  /** A worktree on a friend's computer, with the project already picked. */
  | { readonly kind: 'remote'; readonly peerId: string; readonly project?: string }
  /** "Are you sure?" before a menu option that removes something; Confirm picks it. */
  | { readonly kind: 'confirm_option'; readonly menu: MenuKind; readonly index: number; readonly id: string }
  /** "Are you sure?" for something that isn't a menu option (from the palette). */
  | { readonly kind: 'confirm'; readonly title: string; readonly message: string; readonly confirm: string; readonly destructive?: boolean; readonly run: () => void }
  /** What a workspace action that starts Claude or changes git will do, before it does (see work-confirm.ts). */
  | { readonly kind: 'work'; readonly wsId: string; readonly action: AskedWork }
  /** A project's worktrees made outside Beluga that can go, ticked, before removing them. */
  | { readonly kind: 'clean_up_worktrees'; readonly projectId: string }
  /** Delete Project…: out of Beluga with the worktrees it made (archived); the project's folder is never touched. */
  | { readonly kind: 'delete_project'; readonly projectId: string }
  /** A new task (in a project, a status, under a parent). */
  | { readonly kind: 'new_task'; readonly projectId?: string; readonly status?: import('../../../../src/core/board/model.js').IssueStatus; readonly parent?: string }
  /** A new plan with Claude: what it's for, the project (unset: pick one), how far it runs on its own. */
  | { readonly kind: 'new_plan'; readonly projectId?: string }
  /** Your planning style (how you like plans cut). */
  | { readonly kind: 'plan_style' }
  /** Not yet: what a milestone still needs, for the plan's head Claude. */
  | { readonly kind: 'plan_send_back'; readonly planId: string; readonly milestone: string }
  /** How a running plan runs (its mode), with what a change means from now on. */
  | { readonly kind: 'plan_mode'; readonly planId: string };

type Listener = () => void;

let current: NativeSheet | undefined;
const listeners = new Set<Listener>();

export function openSheet(sheet: NativeSheet): void {
  current = sheet;
  for (const l of [...listeners]) l();
}

/** The sheet showing now, if any. */
export const currentSheet = (): NativeSheet | undefined => current;

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
