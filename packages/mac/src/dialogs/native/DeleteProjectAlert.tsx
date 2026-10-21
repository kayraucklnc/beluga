import { useState } from 'react';
import { Alert, Checkbox } from '../../components/Alert.js';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import { useApi, useApp } from '../../lib/klaud.js';
import { count } from './pick.js';

/**
 * Delete Project…: by default it only leaves Klaud (its worktrees archived first, so nothing
 * is lost); its folder goes to the Trash only if you tick that, and never further than the Trash.
 */
export function DeleteProjectAlert({ projectId, close }: { projectId: string; close: () => void }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId && p.root));
  const [trash, setTrash] = useState(false);
  if (!project) return null;
  const worktrees = project.workspaces.filter((w) => w.kind === 'worktree' && !w.archived && worktreeOrigin(w) === 'klaud').length;
  const remove = (): void => {
    close();
    void api.workspaces.removeProject(project.id, { trash });
  };
  return (
    <Alert
      icon="alert"
      tone="danger"
      title={`Delete “${project.name}”?`}
      message={
        <>
          <p>
            It leaves Klaud: the sidebar, its group and Hidden Projects.
            {worktrees ? <> Its {count(worktrees, 'worktree')} {worktrees === 1 ? 'is' : 'are'} archived first, keeping everything of yours; add the project again to restore them.</> : null}
          </p>
          <p>
            {trash ? (
              <>
                The folder <code>{project.root}</code> goes to the Trash. You can put it back from there.
              </>
            ) : (
              <>
                The folder <code>{project.root}</code> stays where it is.
              </>
            )}
          </p>
        </>
      }
      confirm={{ label: trash ? 'Remove and Move to Trash' : 'Remove from Klaud', destructive: true, onClick: remove }}
      onCancel={close}
    >
      <Checkbox checked={trash} onChange={setTrash} label="Also move the folder to the Trash" detail="Off: the folder isn’t touched" />
    </Alert>
  );
}
