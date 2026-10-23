import type { AppState } from '@beluga/core/store.js';
import type { UiAction } from '@beluga/ui/workspace-models.js';

/**
 * Clicking a project in the sidebar: its home (views/ProjectHome.tsx), where you start work in a
 * new worktree or ask about the project, and find its worktrees and questions. Work never
 * happens in the main checkout itself.
 */
export function openProjectHome(run: (action: UiAction) => void, state: Pick<AppState, 'projects'>, projectId: string): void {
  if (!state.projects.some((p) => p.id === projectId && p.root)) return;
  run({ type: 'view', view: { kind: 'project', id: projectId } });
}
