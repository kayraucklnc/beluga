import { useState } from 'react';
import type { EnvChange } from '@klaud/workspaces/env.js';
import { findWorkspace } from '@klaud/ui/workspace-models.js';
import { Alert, Checkbox } from '../../components/Alert.js';
import { useApi, useApp } from '../../lib/klaud.js';
import type { NativeMenuProps } from './index.js';
import { count, usePick } from './pick.js';
import s from './menus.module.css';

const NO_ENV: readonly EnvChange[] = [];

/** The keys that differ in one env file, as small tags: +NEW, ~CHANGED, −REMOVED. */
function EnvKeys({ change }: { change: EnvChange }) {
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

/**
 * Archive or delete a workspace: what happens, in a sentence; uncommitted work offers to commit
 * first; env changes the main folder doesn't have are listed and copied back if you like.
 */
export function ConfirmAlert({ menu, close }: NativeMenuProps<'confirm'>) {
  const api = useApi();
  const pick = usePick(menu);
  const ws = useApp((st) => findWorkspace(st.projects, menu.id));
  const env = useApp((st) => st.envChanges[menu.id] ?? NO_ENV);
  const [copyEnv, setCopyEnv] = useState(true);
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
                'This removes it from Klaud and deletes the conversation.'
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
  const message = (
    <>
      <p>
        {worktree ? (
          <>
            The worktree folder is removed. Its branch <code>{ws.branch ?? ''}</code> and the conversation are kept, so you can restore it later.
          </>
        ) : (
          'The chat leaves the sidebar. You can restore it from Overview.'
        )}
      </p>
      {changed ? (
        <p>
          <strong className={s.warn}>{count(changed, 'file')} {changed === 1 ? 'has' : 'have'} uncommitted changes.</strong> Commit them to keep them on the branch; archiving anyway discards them.
        </p>
      ) : null}
    </>
  );
  // With env changes, "copy them first" goes before whichever way you archive.
  const archive = (force: boolean): void => void pick(withEnv ? 'confirm-archive-env' : force ? 'confirm-archive-force' : 'confirm-archive');
  const commitAndArchive = (): void => {
    if (withEnv) void api.workspaces.applyEnvBack(menu.id).then(() => pick('confirm-commit-archive'));
    else pick('confirm-commit-archive');
  };
  return (
    <Alert
      icon="archive"
      tone={changed ? 'caution' : 'info'}
      title={`Archive “${ws.name}”?`}
      message={message}
      table={table}
      confirm={changed ? { label: 'Commit & Archive', onClick: commitAndArchive } : { label: 'Archive', onClick: () => archive(false) }}
      {...(changed ? { alternative: { label: 'Archive Anyway', destructive: true, onClick: () => archive(true) } } : {})}
      onCancel={close}
    >
      {envBox}
    </Alert>
  );
}
