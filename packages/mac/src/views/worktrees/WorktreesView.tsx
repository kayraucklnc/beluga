import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '@klaud/shared/format.js';
import { Icon } from '../../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../../components/SpecMenu.js';
import { Button, Empty, Segmented } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { toast, useApi, useApp, useKlaud } from '../../lib/klaud.js';
import { type Batch, BatchAlert } from './BatchAlerts.js';
import { WorktreeItem } from './WorktreeItem.js';
import { forgetRebuildable, useRebuildable } from './use-rebuildable.js';
import { FILTERS, type WorktreeFilter, type WorktreeRow, filterRows, totals, worktreeRows } from './worktrees-model.js';
import s from './worktrees.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Every worktree in your projects, made by Klaud, by Claude Code's sub-agents or outside Klaud:
 * who made it (for a sub-agent, the conversation that started it, or that it's gone), whether
 * its work is done, what it takes on disk and how much of that is dependencies, builds and
 * caches. Tick the ones you're done with, then archive them (everything of yours is kept) or
 * free up their space (they stay).
 */
export function WorktreesView({ projectId }: { projectId?: string | undefined }) {
  const api = useApi();
  const { client } = useKlaud();
  const actions = useActions();
  const projects = useApp((st) => st.projects);
  const disk = useApp((st) => st.disk);
  const prs = useApp((st) => st.prs);
  const claudeCode = useApp((st) => st.claudeCode);
  const archiving = useApp((st) => st.archiving);
  const rows = useMemo(() => worktreeRows({ projects, disk, prs, claudeCode, archiving }), [projects, disk, prs, claudeCode, archiving]);
  const [filter, setFilter] = useState<WorktreeFilter>('all');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<{ kind: Batch; rows: readonly WorktreeRow[] } | undefined>();
  const [running, setRunning] = useState(false);
  const plans = useRebuildable(
    api,
    rows.map((r) => ({ id: r.ws.id, size: r.size })),
  );
  const rebuildable = useMemo(() => Object.fromEntries([...plans].map(([id, p]) => [id, p.dropBytes])), [plans]);
  const project = projects.find((p) => p.id === projectId);
  const shown = filterRows(rows, filter, projectId);
  const sum = totals(shown, rebuildable);
  const picked = rows.filter((r) => ticked.has(r.ws.id));
  const pickedSum = totals(picked, rebuildable);

  // Sizes as they are now.
  useEffect(() => void api.workbench.measureDisk().catch(() => undefined), [api]);
  // Gone (archived, removed): no longer ticked.
  useEffect(() => setTicked((t) => new Set([...t].filter((id) => rows.some((r) => r.ws.id === id)))), [rows]);

  const tick = (id: string, on: boolean): void => setTicked((t) => (on ? new Set([...t, id]) : new Set([...t].filter((x) => x !== id))));
  const allShown = shown.length > 0 && shown.every((r) => ticked.has(r.ws.id));
  const tickAll = (on: boolean): void => setTicked(on ? new Set([...ticked, ...shown.filter((r) => !r.archiving).map((r) => r.ws.id)]) : new Set([...ticked].filter((id) => !shown.some((r) => r.ws.id === id))));

  /** One at a time (each archive is a lot of disk work); what failed says why and the rest go on. */
  const run = async (kind: Batch, list: readonly WorktreeRow[]): Promise<void> => {
    setBatch(undefined);
    setRunning(true);
    try {
      for (const r of list) {
        try {
          if (kind === 'archive') await api.workspaces.archive(r.ws.id);
          else await api.workspaces.freeSpace(r.ws.id);
        } catch (err) {
          toast(client, `${r.ws.name}: ${errorText(err)}`, 'error');
        }
      }
    } finally {
      forgetRebuildable(list.map((r) => r.ws.id));
      setTicked(new Set());
      setRunning(false);
      void api.workbench.measureDisk().catch(() => undefined);
    }
  };
  const act = { archive: (list: readonly WorktreeRow[]) => setBatch({ kind: 'archive', rows: list }), free: (list: readonly WorktreeRow[]) => setBatch({ kind: 'free', rows: list }) };
  const projectItems: ActionItem[] = [
    { label: 'All Projects', checked: !projectId, onSelect: () => actions.run({ type: 'view', view: { kind: 'worktrees' } }) },
    ...projects.filter((p) => p.root && p.workspaces.some((w) => w.kind === 'worktree' && !w.archived)).map((p, i) => ({ label: p.name, checked: p.id === projectId, ...(i === 0 ? { separate: true } : {}), onSelect: () => actions.run({ type: 'view', view: { kind: 'worktrees', projectId: p.id } }) })),
  ];

  if (!rows.length) return <Empty icon="branch" title="No worktrees" detail="Worktrees made by Klaud, by Claude Code’s sub-agents or by other tools show up here, with the space they take." />;
  return (
    <div className={s.page}>
      <header className={s.head}>
        <div className={s.title}>
          <h1>Worktrees</h1>
          <p className={s.summary} aria-live="polite">
            {sum.count} {sum.count === 1 ? 'worktree' : 'worktrees'} · {formatBytes(sum.bytes)}
            {sum.rebuildable ? ` · ${formatBytes(sum.rebuildable)} is dependencies, builds and caches` : ''}
            {sum.measured < sum.count ? <span className={s.pending}> · looking at {sum.count - sum.measured} more…</span> : null}
          </p>
        </div>
        <div className={s.tools}>
          <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS.map((f) => ({ value: f.id, label: `${f.label} ${filterRows(rows, f.id, projectId).length}`, hint: f.hint }))} />
          <ActionsDropdown items={projectItems}>
            <Button size="small" variant="plain">
              {project?.name ?? 'All Projects'} <Icon name="chevronDown" size={10} />
            </Button>
          </ActionsDropdown>
        </div>
      </header>
      <div role="grid" aria-label="Worktrees" aria-multiselectable className={s.grid}>
        <div role="row" className={s.headRow}>
          <span role="columnheader" className={s.tick}>
            <input type="checkbox" aria-label="Select all shown" checked={allShown} onChange={(e) => tickAll(e.target.checked)} />
          </span>
          <span role="columnheader">Worktree</span>
          <span role="columnheader">Made by</span>
          <span role="columnheader">Its work</span>
          <span role="columnheader" className={s.num}>
            Size
          </span>
          <span role="columnheader" className={s.num} title="Dependencies, builds and caches: what archiving or Free Up Space clears">
            Can clear
          </span>
          <span role="columnheader" />
        </div>
        {shown.length ? shown.map((r) => <WorktreeItem key={r.ws.id} row={r} plan={plans.get(r.ws.id)} ticked={ticked.has(r.ws.id)} onTick={(on) => tick(r.ws.id, on)} act={act} />) : <p className={s.none}>Nothing here: {FILTERS.find((f) => f.id === filter)?.hint.toLowerCase()}.</p>}
      </div>
      {picked.length ? (
        <footer className={s.bar} role="toolbar" aria-label="Selected worktrees">
          <span className={s.barText}>
            {picked.length} selected · {formatBytes(pickedSum.bytes)}
            {pickedSum.rebuildable ? ` · ${formatBytes(pickedSum.rebuildable)} can be cleared` : ''}
          </span>
          <Button size="small" variant="quiet" onClick={() => setTicked(new Set())} disabled={running}>
            Deselect
          </Button>
          <Button size="small" onClick={() => act.free(picked)} disabled={running || !pickedSum.rebuildable}>
            Free Up Space…
          </Button>
          <Button size="small" variant="primary" icon="archive" onClick={() => act.archive(picked)} disabled={running}>
            {running ? 'Working…' : 'Archive…'}
          </Button>
        </footer>
      ) : null}
      {batch ? <BatchAlert batch={batch.kind} rows={batch.rows} rebuildable={totals(batch.rows, rebuildable).rebuildable} onConfirm={() => void run(batch.kind, batch.rows)} onCancel={() => setBatch(undefined)} /> : null}
    </div>
  );
}
