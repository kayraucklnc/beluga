import { type ReactNode, useEffect, useState } from 'react';
import type { StaleWorktree } from '@klaud/core/other-worktrees.js';
import { formatBytes } from '@klaud/shared/format.js';
import { SOURCE_FOLDS, type WorktreeSource, sourceFromPath } from '@klaud/workspaces/origin.js';
import type { Project, Workspace } from '@klaud/workspaces/types.js';
import { Alert, Checkbox } from '../components/Alert.js';
import { Icon } from '../components/Icon.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { Badge, IconButton } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useUi } from '../lib/klaud.js';
import { useOrigins } from '../views/worktree-info-state.js';
import { Row } from './sidebar-parts.js';
import s from './Sidebar.module.css';
import o from './other-worktrees.module.css';

/**
 * A project's worktrees made outside Klaud, folded by what made them: Conductor, Claude Code
 * (its sub-agents, or a conversation that ran `git worktree add`), or something else. Each
 * fold explains itself on hover and offers Clean Up… for the ones that can go.
 */

const ORDER: readonly WorktreeSource[] = ['conductor', 'claude', 'other'];

/** Asks which of a fold's stale worktrees to remove (all ticked), with why each is safe and its size. */
function CleanUpAlert({ project, source, onClose }: { project: Project; source: WorktreeSource; onClose: () => void }) {
  const api = useApi();
  const disk = useApp((st) => st.disk);
  const [list, setList] = useState<readonly StaleWorktree[] | undefined>();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api.workspaces.staleOthers(project.id, source).then((found) => {
      if (!live) return;
      setList(found ?? []);
      setTicked(new Set((found ?? []).map((w) => w.id)));
    });
    // Sizes, if they haven't been measured yet.
    void api.workbench.measureDisk().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, project.id, source]);
  const title = SOURCE_FOLDS[source].title;
  if (!list) return <Alert icon="refresh" tone="info" title={`Looking at ${title.toLowerCase()} in ${project.name}…`} confirm={{ label: 'Remove', disabled: true, onClick: () => undefined }} onCancel={onClose} />;
  if (!list.length) {
    return (
      <Alert
        icon="check"
        tone="info"
        title="Nothing to clean up"
        message={<p>Every one of these has work of its own: uncommitted changes, or commits that aren’t in its base branch yet. Remove one from its page if you’re sure.</p>}
        confirm={{ label: 'OK', onClick: onClose }}
        cancel={false}
        onCancel={onClose}
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
      title={`Clean up ${title.toLowerCase()} in ${project.name}?`}
      message={
        <p>
          These have nothing of their own: no uncommitted changes, and their work is merged or their folder is gone. Klaud removes the folders it’s ticked; branches stay, so nothing committed is lost.
          {frees ? <> This frees about <strong>{formatBytes(frees)}</strong>.</> : null}
        </p>
      }
      confirm={{
        label: chosen.length ? `Remove ${chosen.length}` : 'Remove',
        destructive: true,
        disabled: busy || !chosen.length,
        onClick: () => {
          setBusy(true);
          void api.workspaces.cleanUpOthers(project.id, chosen.map((w) => w.id)).finally(onClose);
        },
      }}
      onCancel={onClose}
    >
      <div className={o.cleanList} role="group" aria-label="Worktrees to remove">
        {list.map((w) => (
          <Checkbox key={w.id} checked={ticked.has(w.id)} onChange={(on) => toggle(w.id, on)} label={<>{w.name}{disk[w.id] !== undefined ? <span className={o.cleanSize}> · {formatBytes(disk[w.id]!)}</span> : null}</>} detail={w.reasonText} />
        ))}
      </div>
    </Alert>
  );
}

function Fold({ p, source, list, row, indent }: { p: Project; source: WorktreeSource; list: readonly Workspace[]; row: (w: Workspace) => ReactNode; indent: number }) {
  const actions = useActions();
  const collapsed = useUi((u) => u.collapsed);
  const viewId = useApp((st) => (st.view.kind === 'workspace' ? st.view.id : undefined));
  const [cleaning, setCleaning] = useState(false);
  const key = `others:${source}:${p.id}`;
  // Folded, it still shows the worktree you're in (only that one), until you go elsewhere.
  const open = collapsed.includes(key);
  const { title, explainer } = SOURCE_FOLDS[source];
  return (
    <>
      <ActionsContext items={[{ label: 'Clean Up…', icon: 'archive', onSelect: () => setCleaning(true) }]}>
        <Row
          indent={indent}
          className={s.fold}
          label={title}
          detail={explainer}
          aria-label={`${title}: ${list.length} worktree${list.length === 1 ? '' : 's'}. ${explainer}`}
          aria-expanded={open}
          icon={<Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />}
          onClick={() => actions.run({ type: 'toggle_fold', key })}
          trailing={
            <>
              <span className={s.hoverTools}>
                <IconButton icon="archive" label={`Clean Up ${title}…`} onClick={(e) => (e.stopPropagation(), setCleaning(true))} />
              </span>
              <Badge count={list.length} />
            </>
          }
        />
      </ActionsContext>
      {open ? list.map((w) => row(w)) : list.filter((w) => w.id === viewId).map((w) => row(w))}
      {cleaning ? <CleanUpAlert project={p} source={source} onClose={() => setCleaning(false)} /> : null}
    </>
  );
}

/** `indent`: the folds' own rows; `row` draws each worktree (one level in). */
export function OtherWorktreeFolds({ p, row, indent = 1 }: { p: Project; row: (w: Workspace) => ReactNode; indent?: number }) {
  const list = p.workspaces.filter((w) => w.kind === 'worktree' && w.external && !w.archived);
  const origins = useOrigins(
    p.id,
    list.map((w) => w.id),
  );
  if (!list.length) return null;
  const sourceOf = (w: Workspace): WorktreeSource => origins[w.id]?.source ?? sourceFromPath(w.path);
  return (
    <>
      {ORDER.map((source) => {
        const inFold = list.filter((w) => sourceOf(w) === source);
        return inFold.length ? <Fold key={source} p={p} source={source} list={inFold} row={row} indent={indent} /> : null;
      })}
    </>
  );
}
