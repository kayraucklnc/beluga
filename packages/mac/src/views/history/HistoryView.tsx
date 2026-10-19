import { useEffect, useState } from 'react';
import { Button, Empty, cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { useApp } from '../../lib/klaud.js';
import { CommitDetail } from './CommitDetail.js';
import { HistoryFilters } from './HistoryFilters.js';
import { HistoryList, type RefContext } from './HistoryList.js';
import { takePendingCommit } from './history-nav.js';
import { type LogQuery, useFilters, useHistoryVersion, useLog, useWorktreeBranches } from './use-history.js';
import s from './history.module.css';

const PAGE = 120;

/** The refs context for a project's history: your worktrees' branches, its upstream, what's checked out. */
export function useRefContext(projectId: string, current?: string): RefContext {
  const project = useApp((st) => st.projects.find((p) => p.id === projectId && p.root));
  const worktrees = useWorktreeBranches(project);
  return { worktrees, ...(project?.sync?.upstream ? { upstream: project.sync.upstream } : {}), ...(current ? { current } : {}) };
}

/**
 * A project's history, full size: every branch as a graph (who committed what, when), filters for
 * branch, author and path, and a commit's details and diffs beside the list.
 */
export function HistoryView({ projectId }: { projectId: string }) {
  const project = useApp((st) => st.projects.find((p) => p.id === projectId && p.root));
  const actions = useActions();
  const version = useHistoryVersion(project);
  const [query, setQuery] = useState<LogQuery>({ branch: 'all' });
  const [selected, setSelected] = useState<string | undefined>(() => takePendingCommit(projectId));
  const filters = useFilters(projectId, version);
  const log = useLog(projectId, query, PAGE, version);
  const refs = useRefContext(projectId, filters?.current);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selected && !(e.target instanceof HTMLInputElement)) setSelected(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);
  if (!project) return <Empty icon="folder" title="This project isn’t here anymore" detail="Pick another one in the sidebar." />;
  const back = (): void => actions.run({ type: 'view', view: { kind: 'project', id: projectId } });
  return (
    <div className={s.page} aria-label={`${project.name} history`}>
      <div className={s.pageHead}>
        <Button size="small" variant="quiet" icon="back" onClick={back}>
          {project.name}
        </Button>
        <h1 className="visually-hidden">{project.name} history</h1>
        <span className={s.flex} />
        <HistoryFilters filters={filters} query={query} onChange={(q) => setQuery(q)} />
      </div>
      <div className={cx(s.split, selected && s.splitOpen)}>
        <section className={s.listPane} aria-label="Commits">
          {log.error && !log.commits.length ? (
            <Empty icon="alert" title="Couldn’t read the history" detail={log.error} />
          ) : !log.commits.length && !log.loading ? (
            <Empty icon="search" title="No commits match" detail={query.path || query.author ? 'Try another path or author, or all branches.' : 'This repository has no commits yet.'} />
          ) : !log.commits.length ? (
            <div className={s.dimPad}>Reading the history…</div>
          ) : (
            <HistoryList commits={log.commits} variant="full" selected={selected} onSelect={setSelected} refs={refs} {...(log.more ? { onEnd: log.loadMore } : {})} loading={log.loading} />
          )}
        </section>
        {selected ? (
          <section className={s.detailPane} aria-label="Commit details">
            <CommitDetail target={projectId} projectId={projectId} hash={selected} refs={refs} onSelect={setSelected} onClose={() => setSelected(undefined)} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
