/**
 * How Claude takes what you send: right away, planning first (Claude Code's plan mode, which you
 * approve), or planning with tasks (a plan of milestones and tasks that goes on the board when you
 * approve it; see core/plans).
 */

export type ComposeMode = 'act' | 'plan' | 'tasks';

export const MODE_INFO: Readonly<Record<ComposeMode, { readonly label: string; readonly hint: string; readonly banner: string }>> = {
  act: { label: 'Act', hint: 'Claude does it right away', banner: '' },
  plan: { label: 'Plan First', hint: 'Claude looks around and asks you to approve a plan; approved, it becomes a task', banner: 'Claude looks around and proposes a plan before changing anything' },
  tasks: { label: 'Plan with Tasks', hint: 'Claude cuts the work into milestones and tasks that can run side by side; nothing reaches the board until you approve', banner: 'Milestones and tasks, drafted here: nothing reaches the board until you approve' },
};

/** ⇧⇥: acting ↔ planning first, as in Claude Code. (Plan with Tasks makes a plan: it's picked from the menu, never a keystroke away.) */
export function nextMode(mode: ComposeMode): ComposeMode {
  return mode === 'act' ? 'plan' : 'act';
}
