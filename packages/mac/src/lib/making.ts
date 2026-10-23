import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { useApp } from './beluga.js';

/**
 * Whether the page you're on is a worktree still being made (see core/optimistic.ts): its row and
 * page show at once, but there's no folder yet for its changes, files or terminal.
 */
export const useMaking = (): boolean => useApp((st) => (st.view.kind === 'workspace' ? findWorkspace(st.projects, st.view.id)?.pending === true : false));
