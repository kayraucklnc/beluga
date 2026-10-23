import { useEffect, useState } from 'react';
import type { StaleWorktree } from '@beluga/core/other-worktrees.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Alert, Checkbox } from '../../components/Alert.js';
import { tildePath } from '../../layout/outside-model.js';
import { useApi, useApp } from '../../lib/beluga.js';
import s from './clean-up.module.css';

/**
 * Clean Up Worktrees…: a project's worktrees made outside Beluga that can go without losing
 * anything (nothing uncommitted, and merged, or their remote branch or folder is gone), all
 * ticked, each with why and how big. Removing keeps every branch.
 */
export function CleanUpWorktreesAlert({ projectId, close }: { projectId: string; close: () => void }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const disk = useApp((st) => st.disk);
  const home = useApp((st) => st.home);
  const [list, setList] = useState<readonly StaleWorktree[] | undefined>();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api.workspaces
      .staleOthers(projectId)
      .then((found) => {
        if (!live) return;
        setList(found ?? []);
        setTicked(new Set((found ?? []).map((w) => w.id)));
      })
      .catch(() => live && setList([]));
    // Sizes, if they haven't been measured yet.
    void api.workbench.measureDisk().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, projectId]);
  if (!project) return null;
  if (!list) return <Alert icon="refresh" tone="info" title={`Looking at the worktrees in ${project.name}…`} confirm={{ label: 'Remove', disabled: true, onClick: () => undefined }} onCancel={close} />;
  if (!list.length) {
    return (
      <Alert
        icon="check"
        tone="info"
        title="Nothing to clean up"
        message={<p>Every worktree made outside Beluga in {project.name} still has work of its own, or is still in use: uncommitted changes, or commits that aren’t in its base branch yet. Remove one from its page if you’re sure.</p>}
        confirm={{ label: 'OK', onClick: close }}
        cancel={false}
        onCancel={close}
      />
    );
  }
  const chosen = list.filter((w) => ticked.has(w.id));
  const frees = chosen.reduce((n, w) => n + (disk[w.id] ?? 0), 0);
  const toggle = (id: string, on: boolean): void => setTicked((t) => (on ? new Set([...t, id]) : new Set([...t].filter((x) => x !== id))));
  return (
    <Alert
      icon="archive"
      tone="caution"
      title={`Clean up worktrees in ${project.name}?`}
      message={
        <p>
          These have nothing of their own: no uncommitted changes, and their work is merged or their folder is gone. Beluga removes the ones you tick; branches stay, so nothing committed is lost.
          {frees ? (
            <>
              {' '}
              This frees about <strong>{formatBytes(frees)}</strong>.
            </>
          ) : null}
        </p>
      }
      confirm={{
        label: chosen.length ? `Remove ${chosen.length}` : 'Remove',
        destructive: true,
        disabled: busy || !chosen.length,
        onClick: () => {
          setBusy(true);
          void api.workspaces
            .cleanUpOthers(projectId, chosen.map((w) => w.id))
            .catch(() => undefined)
            .finally(close);
        },
      }}
      onCancel={close}
    >
      <div className={s.list} role="group" aria-label="Worktrees to remove">
        {list.map((w) => (
          <Checkbox
            key={w.id}
            checked={ticked.has(w.id)}
            onChange={(on) => toggle(w.id, on)}
            label={
              <>
                {w.name}
                {disk[w.id] !== undefined ? <span className={s.size}> · {formatBytes(disk[w.id]!)}</span> : null}
              </>
            }
            detail={
              <>
                <span className={s.where} title={w.path}>
                  {tildePath(home, w.path)}
                </span>
                {w.reasonText}
              </>
            }
          />
        ))}
      </div>
    </Alert>
  );
}
