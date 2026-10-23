import { Alert } from '../../components/Alert.js';
import { worktreeOrigin } from '@beluga/workspaces/origin.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { count } from './pick.js';

/**
 * Delete Project…: it leaves Beluga, and so do the worktrees Beluga made for it (archived first,
 * so nothing of yours is lost). The project's own folder is never touched: not deleted, not
 * moved to the Trash. It leaves the sidebar at once; the archiving goes on in the background.
 */
export function DeleteProjectAlert({ projectId, close }: { projectId: string; close: () => void }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId && p.root));
  if (!project) return null;
  const worktrees = project.workspaces.filter((w) => w.kind === 'worktree' && !w.archived && worktreeOrigin(w) === 'beluga').length;
  const remove = (): void => {
    close();
    void api.workspaces.removeProject(project.id);
  };
  return (
    <Alert
      icon="alert"
      tone="danger"
      title={`Delete “${project.name}” from Beluga?`}
      message={
        <>
          <p>
            It leaves Beluga: the sidebar, its group and Hidden Projects.
            {worktrees ? (
              <>
                {' '}
                The {count(worktrees, 'worktree')} Beluga made for it {worktrees === 1 ? 'goes' : 'go'} too: archived first, so everything of yours in {worktrees === 1 ? 'it' : 'them'} is kept (uncommitted work included), then {worktrees === 1 ? 'its folder is' : 'their folders are'} removed. Add the project again to restore {worktrees === 1 ? 'it' : 'them'}.
              </>
            ) : null}
          </p>
          <p>
            Your project folder <code>{project.root}</code> isn’t touched: nothing in it is deleted or moved to the Trash.
          </p>
        </>
      }
      confirm={{ label: 'Delete from Beluga', destructive: true, onClick: remove }}
      onCancel={close}
    />
  );
}
