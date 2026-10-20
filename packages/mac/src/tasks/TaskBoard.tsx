import { type DragEvent, memo, useEffect, useRef, useState } from 'react';
import { type Issue, type IssueStatus, PRIORITY_INFO, STATUS_INFO, byRank } from '@klaud/core/board/model.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { IconButton, cx } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { AssigneeMark, PriorityIcon, StatusIcon } from './marks.js';
import { IssueMeta, useIssueMenu } from './parts.js';
import { useSelfId, useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';

/**
 * Tasks as a board: a column per status, cards in priority order. Drag a card to another column
 * to change its status, or up and down to put it in its place (a line shows where it lands).
 */

const DRAG = 'application/x-klaud-task';

interface Drop {
  readonly status: IssueStatus;
  /** Where in the column it lands (index among the column's cards). */
  readonly index: number;
}

export function TaskBoard({ issues, statuses, projectId }: { issues: readonly Issue[]; statuses: readonly IssueStatus[]; projectId?: string }) {
  const { api, act } = useTaskActions();
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<Drop>();
  // A drag that ends anywhere (dropped outside, Esc) leaves nothing behind.
  useEffect(() => {
    if (!dragging) return;
    const reset = (): void => {
      setDragging(undefined);
      setDrop(undefined);
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, [dragging]);
  const columns = statuses.map((status) => ({ status, items: issues.filter((i) => i.status === status).sort((a, b) => byRank(a, b) || PRIORITY_INFO[a.priority].rank - PRIORITY_INFO[b.priority].rank) }));

  const landing = (status: IssueStatus, e: DragEvent<HTMLElement>, cards: HTMLElement): number => {
    const rows = [...cards.querySelectorAll<HTMLElement>('[data-card]')].filter((el) => el.dataset.card !== dragging);
    const i = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return i < 0 ? rows.length : i;
  };

  const onDrop = (status: IssueStatus, items: readonly Issue[], index: number, id: string): void => {
    const rest = items.filter((i) => i.id !== id);
    const before = rest[index - 1];
    const after = rest[index];
    void act(() => api.move(id, status, { ...(before ? { before: before.id } : {}), ...(after ? { after: after.id } : {}) }));
  };

  return (
    <div className={t.board} role="list" aria-label="Board">
      {columns.map(({ status, items }) => (
        <Column
          key={status}
          status={status}
          items={items}
          dragging={dragging}
          drop={drop?.status === status ? drop.index : undefined}
          projectId={projectId}
          onDragOver={(e, cards) => {
            if (!dragging) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const index = landing(status, e, cards);
            if (drop?.status !== status || drop.index !== index) setDrop({ status, index });
          }}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && drop?.status === status) setDrop(undefined);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData(DRAG) || dragging;
            if (id && drop) onDrop(status, items, drop.index, id);
            setDrop(undefined);
            setDragging(undefined);
          }}
          onDragStart={(id) => setDragging(id)}
          onDragEnd={() => {
            setDragging(undefined);
            setDrop(undefined);
          }}
        />
      ))}
    </div>
  );
}

function Column({
  status,
  items,
  dragging,
  drop,
  projectId,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragStart,
  onDragEnd,
}: {
  status: IssueStatus;
  items: readonly Issue[];
  dragging?: string;
  drop?: number;
  projectId?: string;
  onDragOver: (e: DragEvent<HTMLElement>, cards: HTMLElement) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const cards = useRef<HTMLDivElement>(null);
  // The card being dragged stays where it was (folded away while it hovers somewhere), so its drag ends properly.
  const shown = items.filter((i) => i.id !== dragging);
  return (
    <section
      className={cx(t.column, drop !== undefined && t.columnOver)}
      role="listitem"
      aria-label={`${STATUS_INFO[status].label}, ${items.length}`}
      onDragOver={(e) => cards.current && onDragOver(e, cards.current)}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className={t.columnHead}>
        <StatusIcon status={status} />
        <span className={t.groupName}>{STATUS_INFO[status].label}</span>
        <span className={t.groupCount}>{items.length}</span>
        <span className={t.grow} />
        <IconButton icon="plus" label={`New Task in ${STATUS_INFO[status].label}`} onClick={() => openSheet({ kind: 'new_task', status, ...(projectId ? { projectId } : {}) })} />
      </header>
      <div ref={cards} className={t.cards}>
        {items.map((issue) => {
          const isLifted = issue.id === dragging;
          // The drop line goes before the card at its place among the others (the lifted one doesn't count).
          const place = shown.indexOf(issue);
          return (
            <div key={issue.id}>
              {!isLifted && drop === place ? <div className={t.dropLine} /> : null}
              <Card issue={issue} faded={isLifted} folded={isLifted && drop !== undefined} onDragStart={() => onDragStart(issue.id)} onDragEnd={onDragEnd} />
            </div>
          );
        })}
        {drop !== undefined && drop >= shown.length ? <div className={t.dropLine} /> : null}
        {!items.length && drop === undefined ? <div className={t.columnEmpty}>No tasks</div> : null}
      </div>
    </section>
  );
}

const Card = memo(function Card({ issue, faded, folded, onDragStart, onDragEnd }: { issue: Issue; faded: boolean; folded?: boolean; onDragStart: () => void; onDragEnd: () => void }) {
  const selfId = useSelfId();
  const { open } = useTaskActions();
  const menu = useIssueMenu();
  return (
    <ActionsContext items={() => menu(issue)}>
      <article
        className={cx(t.card, faded && t.cardDragging, folded && t.cardFolded)}
        data-card={issue.id}
        draggable
        role="button"
        tabIndex={0}
        aria-label={`${issue.key} ${issue.title}`}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG, issue.id);
          e.dataTransfer.effectAllowed = 'move';
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onClick={() => open(issue)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open(issue);
          }
        }}
      >
        <div className={t.cardTop}>
          <span className={t.key}>{issue.key}</span>
          <span className={t.grow} />
          <PriorityIcon priority={issue.priority} labelled />
          <AssigneeMark assignee={issue.assignee} selfId={selfId} size={16} />
        </div>
        <div className={cx(t.cardTitle, !STATUS_INFO[issue.status].open && t.titleClosed)}>{issue.title}</div>
        <IssueMeta issue={issue} compact />
      </article>
    </ActionsContext>
  );
});
