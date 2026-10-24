import { useState } from 'react';
import type { ProjectSync } from '@beluga/core/board/model.js';
import { LINEAR_KEY_URL, linearKeyProblem } from '@beluga/shared/tracker-keys.js';
import { Alert, Checkbox } from '../components/Alert.js';
import { Field, FormSheet, Popup, TextInput, formStyles as f } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { openExternal } from '../lib/system.js';
import { ago } from './tasks-model.js';
import { useBoard } from './use-tasks.js';
import s from './SyncSheet.module.css';

interface Team {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/**
 * Sync a project's tasks with Linear, both ways: paste a personal API key, pick the team, and
 * choose Autosync (every minute, and moments after a change here). Once connected: the team,
 * when it last synced, Sync Now, Autosync, and Disconnect. The key stays on this Mac.
 */
export function SyncSheet({ projectId, close }: { projectId: string; close: () => void }) {
  const sync = useBoard().sync?.[projectId];
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const [changing, setChanging] = useState(false);
  if (!project) return <FormSheet title="Sync with Linear" intro="That project is gone." submitLabel="OK" hideSubmit onSubmit={close} onCancel={close} />;
  if (sync && !changing) return <Connected projectId={projectId} name={project.name} sync={sync} onChange={() => setChanging(true)} close={close} />;
  return <ConnectForm projectId={projectId} name={project.name} close={close} onBack={sync ? () => setChanging(false) : undefined} />;
}

function ConnectForm({ projectId, name, close, onBack }: { projectId: string; name: string; close: () => void; onBack: (() => void) | undefined }) {
  const api = useApi();
  const [key, setKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [touched, setTouched] = useState(false);
  const [found, setFound] = useState<{ workspace?: string; teams: readonly Team[] }>();
  const [team, setTeam] = useState('');
  const [auto, setAuto] = useState(true);
  const [pushExisting, setPushExisting] = useState(false);
  const trimmed = key.trim();
  const problem = trimmed ? linearKeyProblem(trimmed) : undefined;
  return (
    <FormSheet
      title={onBack ? `Change how ${name} syncs` : `Sync ${name} with Linear`}
      icon="refresh"
      intro={<p>Issues in a Linear team show up here as tasks, and tasks made here show up in Linear. A change on either side follows to the other. The key stays on this Mac.</p>}
      submitLabel={found ? 'Connect' : 'Check Key'}
      canSubmit={Boolean(trimmed) && !problem && (!found || Boolean(team))}
      cancelLabel={onBack ? 'Back' : 'Cancel'}
      onCancel={onBack ?? close}
      width={560}
      onSubmit={async () => {
        if (!found) {
          const r = await api.board.syncTeams('linear', trimmed);
          if (!r.ok) return r.error;
          if (!r.teams.length) return 'This key sees no teams in Linear';
          setFound({ ...(r.workspace ? { workspace: r.workspace } : {}), teams: r.teams });
          setTeam(r.teams[0]!.id);
          return undefined;
        }
        const r = await api.board.syncConnect(projectId, { provider: 'linear', key: trimmed, teamId: team, auto, pushExisting });
        if (!r.ok) return r.error;
        // Connected: the sheet turns into how it syncs.
        setKey('');
        onBack?.();
        return undefined;
      }}
    >
      <Field
        label="API key"
        htmlFor="linear-key"
        error={problem && touched ? problem : undefined}
        hint={found ? `Checked${found.workspace ? `: ${found.workspace}` : ''}.` : 'Starts with lin_api_. Linear › Settings › Security & access › Personal API keys.'}
        aside={
          <button type="button" className={s.reveal} aria-label={reveal ? 'Hide key' : 'Show key'} aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
            <Icon name="eye" size={13} />
          </button>
        }
      >
        <TextInput
          id="linear-key"
          type={reveal ? 'text' : 'password'}
          mono
          placeholder="lin_api_…"
          value={key}
          invalid={Boolean(problem && touched)}
          onChange={(v) => {
            setKey(v);
            setFound(undefined);
          }}
          onBlur={() => setTouched(true)}
          data-autofocus
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>
      {found ? (
        <>
          <Field label="Team" htmlFor="linear-team" hint="Its issues and this project’s tasks are kept in step.">
            <Popup id="linear-team" label="Team" value={team} options={found.teams.map((t) => ({ value: t.id, label: `${t.name} (${t.key})` }))} onChange={setTeam} />
          </Field>
          <div className={s.options}>
            <Checkbox checked={auto} onChange={setAuto} label="Autosync" detail="Every minute, and moments after a change here" />
            <Checkbox checked={pushExisting} onChange={setPushExisting} label="Also send this project’s open tasks" detail="Otherwise only tasks made from now on go to Linear" />
          </div>
        </>
      ) : (
        <div className={s.howto}>
          <span>Don’t have a key yet?</span>
          <button type="button" className={f.linkButton} onClick={() => void openExternal(LINEAR_KEY_URL)}>
            Create one in Linear
            <Icon name="forward" size={10} />
          </button>
        </div>
      )}
    </FormSheet>
  );
}

function Connected({ projectId, name, sync, onChange, close }: { projectId: string; name: string; sync: ProjectSync; onChange: () => void; close: () => void }) {
  const api = useApi();
  const [confirm, setConfirm] = useState(false);
  if (confirm) {
    return (
      <Alert
        title={`Stop syncing ${name} with Linear?`}
        message="Beluga forgets the key, and tasks here stay as they are, unlinked. Nothing in Linear changes."
        tone="danger"
        confirm={{
          label: 'Disconnect',
          destructive: true,
          onClick: () => {
            void api.board.syncDisconnect(projectId);
            close();
          },
        }}
        onCancel={() => setConfirm(false)}
      />
    );
  }
  return (
    <FormSheet
      title={`${name} syncs with Linear`}
      icon="refresh"
      intro={
        <span className={s.team}>
          {sync.workspace ? `${sync.workspace} · ` : ''}
          {sync.team} <span className={s.teamKey}>{sync.teamKey}</span>
        </span>
      }
      submitLabel="Done"
      hideSubmit
      cancelLabel="Done"
      width={480}
      onSubmit={() => undefined}
      onCancel={close}
      footer={
        <>
          <button type="button" className={f.linkDanger} onClick={() => setConfirm(true)}>
            Disconnect…
          </button>
          <button type="button" className={f.linkButton} onClick={onChange}>
            Change Team or Key…
          </button>
        </>
      }
    >
      <div className={cx(s.status, sync.syncing && s.busy)} aria-live="polite">
        <span className={s.count}>
          {sync.linked} {sync.linked === 1 ? 'task' : 'tasks'} linked
        </span>
        <span className={s.meta}>
          {sync.syncing ? 'Syncing…' : sync.syncedAt ? `Synced ${ago(sync.syncedAt)}` : 'Not synced yet'}
          <button type="button" className={f.linkButton} disabled={sync.syncing} onClick={() => void api.board.syncNow(projectId)}>
            Sync Now
          </button>
        </span>
      </div>
      {sync.error ? (
        <div className={s.problem} role="status">
          <Icon name="alert" size={13} />
          <span>{sync.error.message}</span>
          {sync.error.code === 'auth' ? (
            <button type="button" className={f.linkButton} onClick={onChange}>
              Connect a New Key…
            </button>
          ) : null}
        </div>
      ) : null}
      <Checkbox checked={sync.auto} onChange={(on) => void api.board.syncAuto(projectId, on)} label="Autosync" detail="Every minute, and moments after a change here. Off: only when you press Sync Now." />
      <div className={s.note}>Kept in step: title, status, priority, labels, estimate, due date, parent, and the brief as the description. When both sides change the same thing, the newer change wins.</div>
    </FormSheet>
  );
}
