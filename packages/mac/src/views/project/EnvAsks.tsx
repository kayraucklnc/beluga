import { useEffect, useState } from 'react';
import type { EnvChange } from '@beluga/workspaces/env.js';
import { EnvKeys } from '../../dialogs/native/ConfirmAlert.js';
import { Icon } from '../../components/Icon.js';
import { ActionsDropdown } from '../../components/SpecMenu.js';
import { Button, IconButton, Tip } from '../../components/ui.js';
import { useApi, useApp } from '../../lib/beluga.js';
import { openSheet } from '../../lib/sheets.js';
import { sameDeep } from '../../lib/stable.js';
import s from './env-asks.module.css';

const NONE: readonly EnvChange[] = [];

/**
 * A worktree changed a .env value the main folder doesn't have (BLG-369; brand-new keys went there
 * on their own): its keys, then Copy to Main Folder (every worktree's untouched copy follows), Save
 * in Beluga (every run gets them, the file stays), or behind ••• Keep in This Worktree Only.
 */
function EnvAsk({ wsId, changes, name }: { wsId: string; changes: readonly EnvChange[]; name?: string }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const files = changes.map((c) => c.file);
  const act = (run: () => Promise<unknown>): void => {
    setBusy(true);
    void run().finally(() => setBusy(false));
  };
  return (
    <div className={s.ask} role="status" aria-label="Env changes in this worktree">
      <Icon name="lock" size={13} className={s.icon} />
      <span className={s.text}>
        {name ? <strong>{name} </strong> : null}
        changed {files.length === 1 ? <code>{files[0]}</code> : `${files.length} env files`}
        {changes.length === 1 ? (
          <>
            {' '}
            <EnvKeys change={changes[0]!} />
          </>
        ) : null}
        <span className={s.detail}>{name ? '' : ' · the main folder doesn’t have it'}</span>
      </span>
      <Tip label="Write it into the main folder’s file; other worktrees that didn’t change theirs follow">
        <Button size="small" disabled={busy} onClick={() => act(() => api.workspaces.applyEnvBack(wsId))}>
          Copy to Main Folder
        </Button>
      </Tip>
      <Tip label="The project’s own variables in Beluga: every worktree and run gets them; the file stays as it is">
        <Button size="small" variant="quiet" disabled={busy} onClick={() => act(() => api.workspaces.saveEnvInBeluga(wsId))}>
          Save in Beluga
        </Button>
      </Tip>
      <ActionsDropdown items={[{ label: 'Keep in This Worktree Only', hint: 'asked again if it changes', onSelect: () => act(() => api.workspaces.keepEnvHere(wsId)) }]}>
        <IconButton icon="more" label="More for these env changes" disabled={busy} />
      </ActionsDropdown>
    </div>
  );
}

/** In a worktree's conversation, under its other strips. */
export function EnvStrip({ workspaceId }: { workspaceId: string }) {
  const changes = useApp((st) => st.envAsks[workspaceId] ?? NONE);
  const projectId = useApp((st) => st.projects.find((p) => p.workspaces.some((w) => w.id === workspaceId))?.id);
  const api = useApi();
  // Opening it looks again (an edit made outside Beluga since).
  useEffect(() => {
    if (projectId) void api.workspaces.checkEnv(projectId).catch(() => undefined);
  }, [workspaceId, projectId]);
  if (!changes.length) return null;
  return (
    <div className={s.strip}>
      <EnvAsk wsId={workspaceId} changes={changes} />
    </div>
  );
}

/** On a project's page: each of its worktrees that changed a .env. */
export function ProjectEnvAsks({ projectId }: { projectId: string }) {
  const api = useApi();
  const asks = useApp((st) => {
    const ws = st.projects.find((p) => p.id === projectId)?.workspaces ?? [];
    return ws.filter((w) => st.envAsks[w.id]?.length).map((w) => ({ id: w.id, name: w.name, changes: st.envAsks[w.id]! }));
  }, sameDeep);
  useEffect(() => {
    void api.workspaces.checkEnv(projectId).catch(() => undefined);
  }, [projectId]);
  if (!asks.length) return null;
  return (
    <div className={s.list}>
      {asks.map((a) => (
        <EnvAsk key={a.id} wsId={a.id} name={a.name} changes={a.changes} />
      ))}
    </div>
  );
}

/** The project page's Environment pill: how many it sets here, and the sheet to change them. */
export function EnvPill({ projectId, root }: { projectId: string; root: string }) {
  const own = useApp((st) => st.envKeys.projects[root]?.keys.length ?? 0);
  const off = useApp((st) => st.envKeys.projects[root]?.dotenv === false);
  return (
    <Tip label={off ? 'Its variables (the main folder’s .env is switched off)' : 'Its variables and the main folder’s .env'}>
      <button type="button" className={s.pill} onClick={() => openSheet({ kind: 'project_env', projectId })}>
        <Icon name="lock" size={11} />
        Environment
        {own ? <strong>{own}</strong> : null}
      </button>
    </Tip>
  );
}
