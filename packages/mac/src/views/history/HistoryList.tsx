import { type KeyboardEvent, memo, useEffect, useMemo, useRef } from 'react';
import type { CommitInfo } from '@beluga/workspaces/history.js';
import { Icon } from '../../components/Icon.js';
import { cx } from '../../components/ui.js';
import { useActions } from '../../lib/actions.js';
import { type GraphRow, laneColor, layoutGraph, segmentPath } from './graph.js';
import { type Pill, authorColor, fullDate, initials, pillsOf, timeAgo } from './history-model.js';
import s from './history.module.css';

/** How the list looks: `full` one line per commit (a page, the project home); `compact` two (the panel). */
export type ListVariant = 'full' | 'compact';

const ROW = { full: 34, compact: 46 } as const;
const LANE = 14;
const PAD = 11;
const MAX_LANES = 9;
/** Refs shown on a row; the rest fold into “+2” (the detail lists them all). */
const MAX_PILLS = 3;

export interface RefContext {
  readonly worktrees: ReadonlyMap<string, { id: string; name: string }>;
  readonly upstream?: string;
  readonly current?: string;
}

/** A person's initials in their color (no pictures: nothing leaves the computer). */
export function AuthorAvatar({ name, email, size = 20 }: { name: string; email: string; size?: number }) {
  return (
    <span className={s.avatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: authorColor(email || name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/**
 * One row's slice of the graph: the lines through it and the commit's dot. Only as wide as the
 * lanes running through this row, so the text sits right beside its dot instead of after a gap
 * kept for a busier stretch of the graph further down.
 */
function GraphCell({ row, lanes, height, head, incoming }: { row: GraphRow; lanes: number; height: number; head: boolean; incoming: boolean }) {
  const width = PAD * 2 + (Math.max(1, Math.min(lanes, row.width)) - 1) * LANE;
  const cx0 = PAD + Math.min(row.lane, lanes - 1) * LANE;
  const color = laneColor(row.color);
  return (
    <svg className={s.graph} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {row.segments
        .filter((seg) => seg.from < lanes && seg.to < lanes)
        .map((seg, i) => (
          <path key={i} d={segmentPath(seg, height, LANE, PAD)} stroke={laneColor(seg.color)} strokeWidth={1.75} fill="none" strokeLinecap="round" />
        ))}
      {head ? <circle cx={cx0} cy={height / 2} r={6.5} fill="none" stroke={color} strokeWidth={1.5} opacity={0.45} /> : null}
      {row.merge ? (
        <circle cx={cx0} cy={height / 2} r={4} className={s.mergeDot} stroke={color} strokeWidth={2} />
      ) : (
        <circle cx={cx0} cy={height / 2} r={incoming ? 3.5 : 4} fill={color} stroke={incoming ? color : 'none'} strokeWidth={incoming ? 1.75 : 0} className={incoming ? s.incomingDot : undefined} />
      )}
    </svg>
  );
}

/** A branch, tag or HEAD on a commit. Your worktrees' branches open their worktree. */
export function RefPill({ pill }: { pill: Pill }) {
  const actions = useActions();
  const body = (
    <>
      {pill.tone === 'worktree' ? <Icon name="branch" size={10} /> : null}
      {pill.tone === 'tag' ? <span className={s.tagMark}>#</span> : null}
      <span className={s.pillText}>{pill.label}</span>
    </>
  );
  if (pill.worktree) {
    const wt = pill.worktree;
    return (
      <button
        type="button"
        className={cx(s.pill, s[`pill_${pill.tone}`])}
        title={pill.title}
        onClick={(e) => {
          e.stopPropagation();
          actions.run({ type: 'open_ws', id: wt.id, tab: 'chat' });
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={cx(s.pill, s[`pill_${pill.tone}`])} title={pill.title}>
      {body}
    </span>
  );
}

interface RowProps {
  readonly commit: CommitInfo;
  readonly row: GraphRow;
  readonly lanes: number;
  readonly variant: ListVariant;
  readonly selected: boolean;
  readonly refs: RefContext;
  readonly now: number;
  readonly onSelect: (hash: string) => void;
}

const CommitRow = memo(function CommitRow({ commit: c, row, lanes, variant, selected, refs, now, onSelect }: RowProps) {
  const pills = pillsOf(c.refs, refs);
  const head = c.refs.some((r) => r.kind === 'head');
  const when = timeAgo(c.date, now);
  const time = (
    <time className={s.time} dateTime={new Date(c.date).toISOString()} title={fullDate(c.date)}>
      {when}
    </time>
  );
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={`${c.subject}, ${c.author.name}, ${when}${c.incoming ? ', not in your checkout yet' : ''}`}
      data-hash={c.hash}
      className={cx(s.row, s[`row_${variant}`], selected && s.rowOn, c.incoming && s.rowIncoming)}
      style={{ height: ROW[variant] }}
      onClick={() => onSelect(c.hash)}
    >
      <GraphCell row={row} lanes={lanes} height={ROW[variant]} head={head} incoming={Boolean(c.incoming)} />
      {variant === 'full' ? (
        <>
          <span className={s.subjectCell}>
            {pills.slice(0, MAX_PILLS).map((p) => (
              <RefPill key={`${p.tone}:${p.label}`} pill={p} />
            ))}
            {pills.length > MAX_PILLS ? (
              <span className={cx(s.pill, s.pill_more)} title={pills.slice(MAX_PILLS).map((p) => p.label).join('\n')}>
                +{pills.length - MAX_PILLS}
              </span>
            ) : null}
            {c.incoming ? <span className={cx(s.pill, s.pill_incoming)} title="On the remote, not in your checkout yet: Update main brings it in">incoming</span> : null}
            <span className={s.subject} title={c.subject}>
              {c.subject}
            </span>
          </span>
          <span className={s.authorCell} title={`${c.author.name} <${c.author.email}>`}>
            <AuthorAvatar name={c.author.name} email={c.author.email} size={18} />
            <span className={s.authorName}>{c.author.name}</span>
          </span>
          {time}
          <span className={s.hash}>{c.short}</span>
        </>
      ) : (
        <>
          <AuthorAvatar name={c.author.name} email={c.author.email} size={22} />
          <span className={s.twoLine}>
            <span className={s.subjectLine}>
              <span className={s.subject} title={c.subject}>
                {c.subject}
              </span>
            </span>
            <span className={s.metaLine}>
              {pills.slice(0, 2).map((p) => (
                <RefPill key={`${p.tone}:${p.label}`} pill={p} />
              ))}
              {c.incoming ? <span className={cx(s.pill, s.pill_incoming)}>incoming</span> : null}
              <span className={s.authorName}>{c.author.name}</span>
              <span className={s.dot}>·</span>
              {time}
            </span>
          </span>
          <span className={s.hash}>{c.short}</span>
        </>
      )}
    </div>
  );
});

export interface HistoryListProps {
  readonly commits: readonly CommitInfo[];
  readonly variant: ListVariant;
  readonly selected?: string;
  readonly onSelect: (hash: string) => void;
  readonly refs: RefContext;
  /** Load the next page when the end scrolls into view (unset: no more). */
  readonly onEnd?: () => void;
  readonly loading?: boolean;
  readonly label?: string;
}

/** Commits with their graph: lanes in color, merges reaching over, your worktrees' branches highlighted. */
export function HistoryList({ commits, variant, selected, onSelect, refs, onEnd, loading, label = 'Commits' }: HistoryListProps) {
  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = Math.max(1, Math.min(MAX_LANES, graph.width));
  const end = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const now = useMemo(() => Date.now(), [commits]);
  useEffect(() => {
    const el = end.current;
    if (!el || !onEnd) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onEnd(), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [onEnd, commits.length]);
  // Keep the selected row in view as the keyboard moves it.
  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector<HTMLElement>(`[data-hash="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = commits.findIndex((c) => c.hash === selected);
    const next = commits[Math.max(0, Math.min(commits.length - 1, at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) onSelect(next.hash);
  };
  return (
    <div ref={list} className={cx(s.list, s[`list_${variant}`])} role="listbox" aria-label={label} tabIndex={0} onKeyDown={onKey}>
      {commits.map((c, i) => (
        <CommitRow key={c.hash} commit={c} row={graph.rows[i]!} lanes={lanes} variant={variant} selected={c.hash === selected} refs={refs} now={now} onSelect={onSelect} />
      ))}
      {onEnd ? <div ref={end} className={s.end} /> : null}
      {loading && commits.length ? <div className={s.loadingMore}>Loading more…</div> : null}
    </div>
  );
}
