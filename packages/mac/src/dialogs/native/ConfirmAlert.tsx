import { useEffect, useState } from 'react';
import type { ArchivePreview } from '@beluga/workspaces/archive.js';
import { formatBytes } from '@beluga/shared/format.js';
import type { EnvChange } from '@beluga/workspaces/env.js';
import { findWorkspace } from '@beluga/ui/workspace-models.js';
import { Alert, Checkbox } from '../../components/Alert.js';
import { useApi, useApp } from '../../lib/beluga.js';
import type { NativeMenuProps } from './index.js';
import { count, usePick } from './pick.js';
import s from './menus.module.css';

const NO_ENV: readonly EnvChange[] = [];

/** The keys that differ in one env file, as small tags: +NEW, ~CHANGED, −REMOVED. */
export function EnvKeys({ change }: { change: EnvChange }) {
  if (change.binary) return <span className={s.muted}>the file differs</span>;
  return (
    <span className={s.keys}>
      {change.added.map((k) => (
        <span key={`+${k}`} className={s.keyAdded} title="Added in this worktree">
          +{k}
        </span>
      ))}
      {change.changed.map((k) => (
        <span key={`~${k}`} className={s.keyChanged} title="Changed in this worktree">
          ~{k}
        </span>
      ))}
      {change.removed.map((k) => (
        <span key={`-${k}`} className={s.keyRemoved} title="Removed in this worktree">
          −{k}
        </span>
      ))}
    </span>
  );
}

/** What archiving a worktree would clear (asked once the dialog opens; undefined until then). */
function useArchivePlan(id: string, worktree: boolean): ArchivePreview | undefined {
  const api = useApi();
  const [plan, setPlan] = useState<ArchivePreview | undefined>();
  useEffect(() => {
    if (!worktree) return;
    let live = true;
    api.workspaces.archivePlan(id).then(
      (p) => live && setPlan(p ?? undefined),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, worktree]);
  return plan;
}

/**
 * Archive or delete a workspace: what happens, in a sentence; archiving keeps everything of
 * yours (uncommitted work too) and says how much space it frees; env changes the main folder
 * doesn't have are listed and copied back if you like.
 */
export function ConfirmAlert({ menu, close }: NativeMenuProps<'confirm'>) {
  const api = useApi();
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const env = useApp((st) => st.envChanges[menu.id] ?? NO_ENV);
  const [copyEnv, setCopyEnv] = useState(true);
  const plan = useArchivePlan(menu.id, menu.action !== 'delete' && ws?.kind === 'worktree' && !ws.archived);
  if (!ws) return null;
  const changed = ws.status?.changed ?? 0;
  const table = env.length
    ? {
        caption: 'Env changes the main folder doesn’t have',
        columns: ['File', 'Keys'],
        rows: env.map((c) => [<code key="f">{c.file}</code>, <EnvKeys key="k" change={c} />]),
      }
    : undefined;
  const envBox = env.length ? <Checkbox checked={copyEnv} onChange={setCopyEnv} label="Copy these env changes to the main folder first" detail="Keeps the keys you added here" /> : null;
  const withEnv = copyEnv && env.length > 0;

  if (menu.action === 'delete') {
    const worktree = ws.kind === 'worktree' && !ws.external;
    return (
      <Alert
        icon="alert"
        tone="danger"
        title={`Delete “${ws.name}”?`}
        message={
          <>
            <p>
              {worktree ? (
                <>
                  This deletes the worktree folder, its branch <code>{ws.branch ?? ''}</code> and the conversation.
                </>
              ) : (
                'This removes it from Beluga and deletes the conversation.'
              )}
            </p>
            <p>You can’t undo this.</p>
          </>
        }
        table={table}
        confirm={{ label: 'Delete', destructive: true, onClick: () => pick(withEnv ? 'confirm-delete-env' : 'confirm-delete') }}
        onCancel={close}
      >
        {envBox}
      </Alert>
    );
  }

  const worktree = ws.kind === 'worktree';
  const freed = plan?.dropBytes ? ` (${formatBytes(plan.dropBytes)} here)` : '';
  const message = (
    <>
      <p>
        {worktree ? (
          <>
            Everything of yours is kept: {changed ? <strong>{count(changed, 'uncommitted file')}</strong> : 'uncommitted changes'}, new files, and ignored files like <code>.env</code>. Its dependencies, builds and caches are cleared to save space{freed}, and the folder goes.
          </>
        ) : (
          'The chat leaves the sidebar. You can restore it from Overview.'
        )}
      </p>
      {worktree ? (
        <p>
          Its branch <code>{ws.branch ?? ''}</code> and the conversation stay. Restoring brings the folder back as it was{plan?.remake.length ? <> and runs the project’s setup to make the rest again</> : null}.
        </p>
      ) : null}
    </>
  );
  // With env changes, "copy them first" goes before whichever way you archive.
  const archive = (): void => void pick(withEnv ? 'confirm-archive-env' : 'confirm-archive');
  const commitAndArchive = (): void => {
    if (withEnv) void api.workspaces.applyEnvBack(menu.id).then(() => pick('confirm-commit-archive'));
    else pick('confirm-commit-archive');
  };
  return (
    <Alert
      icon="archive"
      tone="info"
      title={`Archive “${ws.name}”?`}
      message={message}
      table={table}
      confirm={{ label: 'Archive', onClick: archive }}
      {...(changed ? { alternative: { label: 'Commit & Archive', onClick: commitAndArchive } } : {})}
      onCancel={close}
    >
      {envBox}
    </Alert>
  );
}
