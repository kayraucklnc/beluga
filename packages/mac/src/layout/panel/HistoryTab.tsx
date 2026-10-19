import { useState } from 'react';
import { Empty } from '../../components/ui.js';
import { CommitDetail } from '../../views/history/CommitDetail.js';
import { HistoryFilters } from '../../views/history/HistoryFilters.js';
import { HistoryList } from '../../views/history/HistoryList.js';
import { useRefContext } from '../../views/history/HistoryView.js';
import { type LogQuery, useFilters, useHistoryProject, useHistoryVersion, useLog } from '../../views/history/use-history.js';
import h from '../../views/history/history.module.css';

const PAGE = 80;

/**
 * The right panel's History: for a worktree, its branch (and where it came from); for a project,
 * every branch. A commit opens in place (its message, files and diffs); Back returns to the list.
 * The panel mounts one per target (keyed), so a new target starts fresh.
 */
export function HistoryTab({ target }: { target: string }) {
  const project = useHistoryProject(target);
  const isProject = project?.id === target;
  const version = useHistoryVersion(project);
  const [query, setQuery] = useState<LogQuery>({ branch: isProject ? 'all' : 'current' });
  const [selected, setSelected] = useState<string>();
  const filters = useFilters(target, version);
  const log = useLog(target, query, PAGE, version);
  const refs = useRefContext(project?.id ?? '', filters?.current);
  if (!project) return <Empty icon="clock" title="No history here" detail="History shows for projects and their worktrees." />;
  if (selected) {
    return (
      <div className={h.tab}>
        <CommitDetail target={target} projectId={project.id} hash={selected} refs={refs} onSelect={setSelected} onClose={() => setSelected(undefined)} compact />
      </div>
    );
  }
  return (
    <div className={h.tab}>
      <HistoryFilters filters={filters} query={query} onChange={setQuery} compact />
      <div className={h.tabList}>
        {log.error && !log.commits.length ? (
          <Empty icon="alert" title="Couldn’t read the history" detail={log.error} />
        ) : !log.commits.length && !log.loading ? (
          <Empty icon="search" title="No commits match" detail="Try another branch, author or path." />
        ) : !log.commits.length ? (
          <div className={h.dimPad}>Reading the history…</div>
        ) : (
          <HistoryList commits={log.commits} variant="compact" onSelect={setSelected} refs={refs} {...(log.more ? { onEnd: log.loadMore } : {})} loading={log.loading} />
        )}
      </div>
    </div>
  );
}
