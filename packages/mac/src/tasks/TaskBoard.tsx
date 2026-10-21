import { type PointerEvent as ReactPointerEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform, useVelocity } from 'motion/react';
import { type Issue, type IssueStatus, PRIORITY_INFO, STATUS_INFO, byRank } from '@klaud/core/board/model.js';
import { ActionsContext } from '../components/SpecMenu.js';
import { IconButton, cx } from '../components/ui.js';
import { openSheet } from '../lib/sheets.js';
import { type Box, columnAt, edgeSpeed, isDrag, landingIndex, leanFor, neighbours, withGap } from './board-drag.js';
import { AssigneeMark, PriorityIcon, StatusIcon } from './marks.js';
import { IssueMeta, useIssueMenu } from './parts.js';
import { useSelfId, useSolo, useTaskActions } from './use-tasks.js';
import t from './tasks.module.css';

/**
 * Tasks as a board: a column per status. Pick a card up and it lifts, leaning with the way you
 * move it; the cards where it would land slide apart to make room, and on release it settles
 * into its place. Esc puts it back. ⌥← ⌥→ move a focused card across columns, ⌥↑ ⌥↓ within one.
 */

interface Lift {
  readonly id: string;
  readonly from: IssueStatus;
  readonly fromIndex: number;
  readonly width: number;
  readonly height: number;
  /** Where the pointer holds the card. */
  readonly grabX: number;
  readonly grabY: number;
  readonly originX: number;
  readonly originY: number;
}

interface Spot {
  readonly status: IssueStatus;
  readonly index: number;
}

/** A move made here, shown at once while the board catches up. */
interface Pending {
  readonly id: string;
  readonly status: IssueStatus;
  readonly index: number;
  /** Which move it is (a later move's answer doesn't clear an earlier one's, nor the other way round). */
  readonly seq: number;
}

let moves = 0;

const GAP = 6;
const SPRING = { type: 'spring', stiffness: 560, damping: 44, mass: 0.75 } as const;
const SETTLE = { type: 'spring', stiffness: 420, damping: 36, mass: 0.8 } as const;

const order = (a: Issue, b: Issue): number => byRank(a, b) || PRIORITY_INFO[a.priority].rank - PRIORITY_INFO[b.priority].rank;

export function TaskBoard({ issues, statuses, projectId }: { issues: readonly Issue[]; statuses: readonly IssueStatus[]; projectId?: string }) {
  const { api, act } = useTaskActions();
  const reduce = useReducedMotion() ?? false;
  const [lift, setLift] = useState<Lift>();
  const [over, setOver] = useState<Spot>();
  const [pending, setPending] = useState<Pending>();
  const [settling, setSettling] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<IssueStatus, HTMLElement>());
  const stacks = useRef(new Map<IssueStatus, HTMLElement>());
  const justDragged = useRef(false);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const lean = useSpring(useTransform(useVelocity(x), (v) => (reduce ? 0 : leanFor(v))), { stiffness: 260, damping: 22 });

  // Columns as the board says, with a move made here shown where it was dropped until the board catches up.
  const columns = useMemo(() => {
    const cols = statuses.map((status) => ({ status, items: issues.filter((i) => i.status === status && i.id !== pending?.id).sort(order) }));
    const moved = pending && issues.find((i) => i.id === pending.id);
    const into = moved && cols.find((c) => c.status === pending.status);
    if (moved && into) into.items.splice(Math.min(pending.index, into.items.length), 0, moved);
    return cols;
  }, [issues, statuses, pending]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  /** Where the pointer would drop the card: the column under it, and the place among its cards (layout positions, the gap taken out). */
  const spotAt = useCallback(
    (px: number, py: number, current: Lift, gap: Spot | undefined): Spot | undefined => {
      const cols = statuses.flatMap((status) => {
        const el = sections.current.get(status);
        if (!el) return [];
        const r = el.getBoundingClientRect();
        return [{ key: status, box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }];
      });
      const status = columnAt(px, cols);
      const stack = status ? stacks.current.get(status) : undefined;
      if (!status || !stack) return undefined;
      const top = stack.getBoundingClientRect().top - stack.scrollTop;
      const shift = current.height + GAP;
      const boxes: Box[] = [...stack.querySelectorAll<HTMLElement>('[data-card]')].map((el) => {
        const pos = Number(el.dataset.pos);
        const at = el.offsetTop - (gap?.status === status && pos >= gap.index ? shift : 0);
        return { top: top + at, bottom: top + at + el.offsetHeight, left: 0, right: 0 };
      });
      return { status, index: landingIndex(py, boxes) };
    },
    [statuses],
  );

  // Dragging: follow the pointer, find the spot, scroll near the edges; release settles or Esc puts it back.
  useEffect(() => {
    if (!lift || settling) return;
    let spot = over;
    let pointer = { x: lift.originX + lift.grabX, y: lift.originY + lift.grabY };
    let frame = 0;
    const scroll = (): void => {
      const board = boardRef.current;
      if (board) {
        const r = board.getBoundingClientRect();
        const dx = edgeSpeed(pointer.x, r.left, r.right);
        if (dx) board.scrollLeft += dx;
      }
      const stack = spot ? stacks.current.get(spot.status) : undefined;
      if (stack) {
        const r = stack.getBoundingClientRect();
        const dy = pointer.y > r.top - 20 && pointer.y < r.bottom + 20 ? edgeSpeed(pointer.y, r.top, r.bottom, 44, 14) : 0;
        if (dy) stack.scrollTop += dy;
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    const move = (e: PointerEvent): void => {
      pointer = { x: e.clientX, y: e.clientY };
      x.set(e.clientX - lift.grabX);
      y.set(e.clientY - lift.grabY);
      const next = spotAt(e.clientX, e.clientY, lift, spot);
      if (next && (next.status !== spot?.status || next.index !== spot.index)) {
        spot = next;
        setOver(next);
      }
    };
    const settle = async (target: Spot, commit: boolean): Promise<void> => {
      setSettling(true);
      setOver(target);
      // The gap is where it goes: fly there, then put it down.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const gap = stacks.current.get(target.status)?.querySelector<HTMLElement>('[data-gap]')?.getBoundingClientRect();
      if (gap && !reduce) await Promise.all([animate(x, gap.left, SETTLE), animate(y, gap.top, SETTLE), animate(lean, 0, SETTLE)]);
      const seq = ++moves;
      if (commit) setPending({ id: lift.id, ...target, seq });
      setLift(undefined);
      setOver(undefined);
      setSettling(false);
      setTimeout(() => (justDragged.current = false), 0);
      if (!commit) return;
      const items = columnsRef.current.find((c) => c.status === target.status)?.items ?? [];
      await act(() => api.move(lift.id, target.status, neighbours(items, lift.id, target.index)));
      setPending((p) => (p?.seq === seq ? undefined : p));
    };
    const up = (): void => {
      // The click that may follow this release isn't one.
      setTimeout(() => (justDragged.current = false), 0);
      const target = spot ?? { status: lift.from, index: lift.fromIndex };
      const same = target.status === lift.from && target.index === lift.fromIndex;
      void settle(target, !same);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      void settle({ status: lift.from, index: lift.fromIndex }, false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
    window.addEventListener('keydown', key, true);
    document.documentElement.dataset.dragging = 'card';
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key, true);
      delete document.documentElement.dataset.dragging;
    };
    // `over` is read once (the spot to start from); it's tracked inside after that.
  }, [lift, settling]);

  /** A press on a card: past a few pixels it's a drag, otherwise a click. */
  const press = (e: ReactPointerEvent<HTMLElement>, issue: Issue, index: number): void => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    const onMove = (m: PointerEvent): void => {
      // The button came up without us hearing it: no drag.
      if (!(m.buttons & 1)) return cleanup();
      if (!isDrag(m.clientX - start.x, m.clientY - start.y)) return;
      cleanup();
      const r = el.getBoundingClientRect();
      justDragged.current = true;
      x.set(r.left + (m.clientX - start.x));
      y.set(r.top + (m.clientY - start.y));
      lean.jump(0);
      const lifted: Lift = { id: issue.id, from: issue.status, fromIndex: index, width: r.width, height: r.height, grabX: start.x - r.left, grabY: start.y - r.top, originX: r.left, originY: r.top };
      setOver({ status: issue.status, index });
      setLift(lifted);
    };
    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
  };

  /** ⌥ and the arrows: the focused card to the next column, or up and down in its own. */
  const nudge = (issue: Issue, key: string): void => {
    const at = statuses.indexOf(issue.status);
    const col = columns.find((c) => c.status === issue.status)?.items ?? [];
    const here = col.findIndex((i) => i.id === issue.id);
    let target: Spot | undefined;
    if (key === 'ArrowLeft' && at > 0) target = { status: statuses[at - 1]!, index: 0 };
    if (key === 'ArrowRight' && at < statuses.length - 1) target = { status: statuses[at + 1]!, index: 0 };
    if (key === 'ArrowUp' && here > 0) target = { status: issue.status, index: here - 1 };
    if (key === 'ArrowDown' && here < col.length - 1) target = { status: issue.status, index: here + 1 };
    if (!target) return;
    const items = columns.find((c) => c.status === target!.status)?.items ?? [];
    const seq = ++moves;
    setPending({ id: issue.id, ...target, seq });
    void act(() => api.move(issue.id, target!.status, neighbours(items, issue.id, target!.index))).then(() => {
      setPending((p) => (p?.seq === seq ? undefined : p));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card="${issue.id}"] [role="button"]`)?.focus());
    });
  };

  const lifted = lift ? issues.find((i) => i.id === lift.id) : undefined;
  // The card went away mid-drag (deleted elsewhere): the drag ends.
  useEffect(() => {
    if (lift && !lifted) {
      setLift(undefined);
      setOver(undefined);
      setSettling(false);
      justDragged.current = false;
    }
  }, [lift, lifted]);
  return (
    <div ref={boardRef} className={cx(t.board, lift && t.boardDragging)} role="list" aria-label="Board">
      {columns.map(({ status, items }) => (
        <section
          key={status}
          ref={(el) => void (el ? sections.current.set(status, el) : sections.current.delete(status))}
          className={cx(t.column, lift && over?.status === status && t.columnOver)}
          role="listitem"
          aria-label={`${STATUS_INFO[status].label}, ${items.length}`}
        >
          <header className={t.columnHead}>
            <StatusIcon status={status} />
            <span className={t.groupName}>{STATUS_INFO[status].label}</span>
            <span className={t.groupCount}>{items.filter((i) => i.id !== lift?.id).length + (lift && over?.status === status ? 1 : 0)}</span>
            <span className={t.grow} />
            <IconButton icon="plus" label={`New Task in ${STATUS_INFO[status].label}`} onClick={() => openSheet({ kind: 'new_task', status, ...(projectId ? { projectId } : {}) })} />
          </header>
          <div ref={(el) => void (el ? stacks.current.set(status, el) : stacks.current.delete(status))} className={t.cards}>
            <AnimatePresence initial={false}>
              {withGap(items, lift?.id, lift && over?.status === status ? over.index : undefined).map((item, pos) =>
                item === 'gap' ? (
                  <motion.div
                    key="gap"
                    data-gap
                    layout={!reduce}
                    className={t.cardGap}
                    style={{ height: lift?.height ?? 64 }}
                    initial={reduce ? false : { opacity: 0, scaleY: 0.4 }}
                    animate={{ opacity: 1, scaleY: 1 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, scaleY: 0.4, height: 0, marginTop: -GAP }}
                    transition={SPRING}
                  />
                ) : (
                  <motion.div key={item.id} data-card={item.id} data-pos={pos - (lift && over?.status === status && over.index <= pos ? 1 : 0)} layout={reduce ? false : 'position'} transition={SPRING} className={t.cardSlot}>
                    <Card
                      issue={item}
                      onPress={(e) => press(e, item, items.filter((i) => i.id !== lift?.id).indexOf(item))}
                      onNudge={(k) => nudge(item, k)}
                      suppressClick={justDragged}
                    />
                  </motion.div>
                ),
              )}
            </AnimatePresence>
            {!items.length && !(lift && over?.status === status) ? <div className={t.columnEmpty}>No tasks</div> : null}
          </div>
        </section>
      ))}
      {lift && lifted
        ? createPortal(
            <motion.div className={t.cardLifted} style={{ x, y, width: lift.width, rotate: lean }} initial={reduce ? false : { scale: 1 }} animate={{ scale: settling ? 1 : 1.035 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} aria-hidden="true">
              <CardFace issue={lifted} />
            </motion.div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** What a card shows (on the board, and lifted under the pointer). */
function CardFace({ issue }: { issue: Issue }) {
  const selfId = useSelfId();
  const solo = useSolo(issue.projectId);
  return (
    <>
      <div className={t.cardTop}>
        <span className={t.key}>{issue.key}</span>
        <span className={t.grow} />
        <PriorityIcon priority={issue.priority} labelled />
        {solo ? null : <AssigneeMark assignee={issue.assignee} selfId={selfId} size={16} />}
      </div>
      <div className={cx(t.cardTitle, !STATUS_INFO[issue.status].open && t.titleClosed)}>{issue.title}</div>
      <IssueMeta issue={issue} compact />
    </>
  );
}

const Card = memo(function Card({ issue, onPress, onNudge, suppressClick }: { issue: Issue; onPress: (e: ReactPointerEvent<HTMLElement>) => void; onNudge: (key: string) => void; suppressClick: { current: boolean } }) {
  const { open } = useTaskActions();
  const menu = useIssueMenu();
  return (
    <ActionsContext items={() => menu(issue)}>
      <article
        className={t.card}
        role="button"
        tabIndex={0}
        aria-label={`${issue.key} ${issue.title}`}
        onPointerDown={onPress}
        onClick={() => {
          // The click that ends a drag isn't a click.
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          open(issue);
        }}
        onKeyDown={(e) => {
          if (e.altKey && e.key.startsWith('Arrow')) {
            e.preventDefault();
            onNudge(e.key);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open(issue);
          }
        }}
      >
        <CardFace issue={issue} />
      </article>
    </ActionsContext>
  );
});
