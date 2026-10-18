import { useEffect } from 'react';
import { worktreeOrigin } from '@klaud/workspaces/origin.js';
import { formatBytes } from '@klaud/shared/format.js';
import { formatTokens } from '@klaud/ui/work-models.js';
import { Icon } from '../components/Icon.js';
import { Button, Empty } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp } from '../lib/klaud.js';
import s from './lists.module.css';

/** Disk space and Claude usage per workspace, biggest first; archive a worktree to free its space. */
export function UsageView() {
  const api = useApi();
  const actions = useActions();
  const projects = useApp((st) => st.projects);
  const disk = useApp((st) => st.disk);
  useEffect(() => void api.workbench.measureDisk(), []);
  const rows = projects
    .flatMap((p) => p.workspaces.filter((w) => !w.archived && worktreeOrigin(w) !== 'agent').map((w) => ({ p, w, disk: disk[w.id] ?? 0, tokens: w.usage ? w.usage.input + w.usage.output + w.usage.cacheWrite : 0, cost: w.usage?.cost ?? 0, runs: w.usage?.runs ?? 0 })))
    .sort((a, b) => b.disk - a.disk || b.tokens - a.tokens);
  const maxDisk = Math.max(1, ...rows.map((r) => r.disk));
  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens));
  const totalDisk = rows.filter((r) => r.w.kind !== 'main').reduce((n, r) => n + r.disk, 0);
  const totalTokens = rows.reduce((n, r) => n + r.tokens, 0);
  const totalCost = rows.reduce((n, r) => n + r.cost, 0);
  if (!rows.length) return <Empty icon="gauge" title="Nothing to measure yet" />;
  return (
    <div className={s.page}>
      <div className={s.summary}>
        <div>
          <div className={s.big}>{formatBytes(totalDisk)}</div>
          <div className={s.dim}>in worktrees</div>
        </div>
        <div>
          <div className={s.big}>{totalTokens ? formatTokens(totalTokens) : '–'}</div>
          <div className={s.dim}>Claude tokens{totalCost ? ` · about $${totalCost.toFixed(2)}` : ''}</div>
        </div>
        <span className={s.flexSpacer} />
        <Button icon="refresh" onClick={() => void api.workbench.measureDisk()}>
          Measure again
        </Button>
      </div>
      <table className={s.usage}>
        <thead>
          <tr>
            <th>Workspace</th>
            <th>Disk</th>
            <th>Claude</th>
            <th className={s.num}>Cost</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.w.id} onClick={() => actions.run({ type: 'open_ws', id: r.w.id })}>
              <td>
                <span className={s.wsName}>
                  <Icon name={r.w.kind === 'chat' ? 'chat' : r.w.kind === 'main' ? 'folder' : 'branch'} size={13} />
                  {r.p.root ? <span className={s.dim}>{r.p.name} ›</span> : null}
                  {r.w.name}
                </span>
              </td>
              <td>
                <span className={s.barCell}>
                  <span className={s.bar} style={{ width: `${(r.disk / maxDisk) * 100}%` }} />
                  <span className={s.barValue}>{r.disk ? formatBytes(r.disk) : '–'}</span>
                </span>
              </td>
              <td>
                <span className={s.barCell}>
                  <span className={`${s.bar} ${s.barClaude}`} style={{ width: `${(r.tokens / maxTokens) * 100}%` }} />
                  <span className={s.barValue}>{r.tokens ? `${formatTokens(r.tokens)} · ${r.runs} run${r.runs === 1 ? '' : 's'}` : '–'}</span>
                </span>
              </td>
              <td className={s.num}>{r.cost ? `$${r.cost.toFixed(2)}` : ''}</td>
              <td className={s.num}>
                {r.w.kind === 'worktree' && !r.w.external ? (
                  <Button size="small" variant="quiet" onClick={(e) => (e.stopPropagation(), actions.run({ type: 'ws', id: r.w.id, action: 'archive' }))}>
                    Archive
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
