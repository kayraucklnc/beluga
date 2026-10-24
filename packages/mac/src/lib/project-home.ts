import type { AppState } from '../../../../src/core/store.js';
import type { UiAction } from '../../../../src/ui/workspace-models.js';

/**
 * Clicking a project in the sidebar: its home (views/ProjectHome.tsx), where you start work in a
 * new worktree or ask about the project, and find its worktrees and questions. Work never
 * happens in the main checkout itself.
 */
export function openProjectHome(run: (action: UiAction) => void, state: Pick<AppState, 'projects'>, projectId: string): void {
  if (!state.projects.some((p) => p.id === projectId && p.root)) return;
  run({ type: 'view', view: { kind: 'project', id: projectId } });
}

/**
 * Where New Chat (⌘N, File › New Chat) starts a chat: in the project you're in (its home, one of
 * its worktrees or chats, a draft or a plan there), a new one on its main folder each time;
 * anywhere else, a chat of its own (not tied to a project).
 */
export function newChatProject(state: Pick<AppState, 'projects' | 'view' | 'plans'>): string {
  const v = state.view;
  const id =
    v.kind === 'project'
      ? v.id
      : v.kind === 'draft' || v.kind === 'draft_worktree'
        ? v.projectId
        : v.kind === 'workspace'
          ? state.projects.find((p) => p.workspaces.some((w) => w.id === v.id))?.id
          : v.kind === 'plan'
            ? state.plans.plans.find((p) => p.id === v.id)?.projectId
            : undefined;
  return id && state.projects.some((p) => p.id === id && p.root) ? id : 'chats';
}
