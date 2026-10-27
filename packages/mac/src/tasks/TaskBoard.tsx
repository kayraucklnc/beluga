import { type PointerEvent as ReactPointerEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform, useVelocity } from 'motion/react';
import { type Issue, type IssueStatus, PRIORITY_INFO, STATUS_INFO, byRank, isEpic } from '@beluga/core/board/model.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Icon } from '../components/Icon.js';
import { IconButton, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { openExternal } from '../lib/system.js';
import { usePlans } from '../plans/use-plans.js';
import { type ColumnGeometry, type Slot, type Span, closeUp, edgeSpeed, isDrag, leanFor, neighbours, spotIn, withGap } from './board-drag.js';
import { AssigneeMark, PriorityIcon, StatusIcon } from './marks.js';
import { ArchiveDoneButton, EpicBar, IssueMeta, OnItLine, useIssueMenu } from './parts.js';
import { WaitingMark } from '../team/Team.js';
import { isSolo } from './tasks-model.js';
import { taskDropProps } from './use-task-drop.js';
import { useBoard, useOthers, useSelf, useSelfId, useTaskActions } from './use-tasks.js';
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

/** The nearest element (the board or one around it) that scrolls sideways; the board itself if none does. */
function sideScroller(el: HTMLElement): HTMLElement {
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const { overflowX } = getComputedStyle(at);
    if ((overflowX === 'auto' || overflowX === 'scroll') && at.scrollWidth > at.clientWidth) return at;
  }
  return el;
}

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
  /** The board measured when the drag started (re-read on scroll). */
  const geometry = useRef<Array<ColumnGeometry<IssueStatus> & { readonly view: Span }>>([]);
  const justDragged = useRef(false);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const lean = useSpring(useTransform(useVelocity(x), (v) => (reduce ? 0 : leanFor(v))), { stiffness: 260, damping: 22 });

  // Columns as the board says, with a move made here shown where it was dropped until the board catches up.
  // A column whose cards didn't change keeps its list, so it doesn't render again.
  const previous = useRef(new Map<IssueStatus, Issue[]>());
  const columns = useMemo(() => {
    const cols = statuses.map((status) => ({ status, items: issues.filter((i) => i.status === status && i.id !== pending?.id).sort(order) }));
    const moved = pending && issues.find((i) => i.id === pending.id);
    const into = moved && cols.find((c) => c.status === pending.status);
    if (moved && into) into.items.splice(Math.min(pending.index, into.items.length), 0, moved);
    const kept = cols.map(({ status, items }) => {
      const was = previous.current.get(status);
      return { status, items: was && was.length === items.length && was.every((i, n) => i === items[n]) ? was : items };
    });
    previous.current = new Map(kept.map((c) => [c.status, c.items]));
    return kept;
  }, [issues, statuses, pending]);
  // What every card needs from the store, read here once: a card itself subscribes to nothing, so a change elsewhere doesn't render them all.
  const board = useBoard();
  const selfId = useSelfId();
  const others = useOthers();
  const soloIn = useMemo(() => [...new Set(issues.map((i) => i.projectId))].filter((p) => isSolo(board, p, selfId, others)).sort().join('\n'), [board, issues, selfId, others]);
  const issueMenu = useIssueMenu();
  const latest = useRef({ columns, statuses, api, act, issueMenu });
  latest.current = { columns, statuses, api, act, issueMenu };
  const menu = useCallback((issue: Issue) => latest.current.issueMenu(issue), []);

  /** Reads where each column and its stack sit on screen; the cards' layout (`cards`) is kept from the drag's start. */
  const frame = (status: IssueStatus, cards: readonly Span[]): (ColumnGeometry<IssueStatus> & { readonly view: Span }) | undefined => {
    const section = sections.current.get(status);
    const stack = stacks.current.get(status);
    if (!section || !stack) return undefined;
    const r = section.getBoundingClientRect();
    const s = stack.getBoundingClientRect();
    return { key: status, box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, origin: s.top - stack.scrollTop, view: { top: s.top, bottom: s.bottom }, cards };
  };

  /** Measures the board once as a drag starts: every column, and its cards' layout with the lifted one taken out. */
  const measure = useCallback((lifted: string): void => {
    geometry.current = latest.current.statuses.flatMap((status) => {
      const stack = stacks.current.get(status);
      if (!stack) return [];
      const slots: Slot[] = [...stack.querySelectorAll<HTMLElement>('[data-card]')].map((el) => ({ id: el.dataset.card!, top: el.offsetTop, height: el.offsetHeight }));
      const col = frame(status, closeUp(slots, lifted, GAP));
      return col ? [col] : [];
    });
  }, []);

  // Dragging: follow the pointer, find the spot, scroll near the edges; release settles or Esc puts it back.
  useEffect(() => {
    if (!lift || settling) return;
    let spot = over;
    let pointer = { x: lift.originX + lift.grabX, y: lift.originY + lift.grabY };
    let tick = 0;
    // What scrolls sideways is the board's container, not the board itself.
    const board = boardRef.current && sideScroller(boardRef.current);
    const edges = board?.getBoundingClientRect();
    const spotAt = (px: number, py: number): Spot | undefined => {
      const at = spotIn(px, py, geometry.current);
      return at && { status: at.key, index: at.index };
    };
    const scroll = (): void => {
      if (board && edges) {
        const dx = edgeSpeed(pointer.x, edges.left, edges.right);
        if (dx) board.scrollLeft += dx;
      }
      const col = spot && geometry.current.find((c) => c.key === spot!.status);
      const stack = col && stacks.current.get(col.key);
      if (col && stack) {
        const { top, bottom } = col.view;
        const dy = pointer.y > top - 20 && pointer.y < bottom + 20 ? edgeSpeed(pointer.y, top, bottom, 44, 14) : 0;
        if (dy) stack.scrollTop += dy;
      }
      tick = requestAnimationFrame(scroll);
    };
    tick = requestAnimationFrame(scroll);
    const follow = (): void => {
      const next = spotAt(pointer.x, pointer.y);
      if (next && (next.status !== spot?.status || next.index !== spot.index)) {
        spot = next;
        setOver(next);
      }
    };
    const move = (e: PointerEvent): void => {
      pointer = { x: e.clientX, y: e.clientY };
      x.set(e.clientX - lift.grabX);
      y.set(e.clientY - lift.grabY);
      follow();
    };
    // Scrolling moves the columns under a still pointer: read where they are now (only their boxes; the cards' layout is the same).
    const scrolled = (): void => {
      geometry.current = geometry.current.flatMap((c) => frame(c.key, c.cards) ?? []);
      follow();
    };
    const settle = async (target: Spot, commit: boolean): Promise<void> => {
      // The gap is where it goes: put it there now, fly to where it sits in the layout (not where it is mid-slide), then put it down.
      flushSync(() => {
        setSettling(true);
        setOver(target);
      });
      const stack = stacks.current.get(target.status);
      const gap = stack?.querySelector<HTMLElement>('[data-gap]');
      if (stack && gap && !reduce) {
        const s = stack.getBoundingClientRect();
        await Promise.all([animate(x, s.left + gap.offsetLeft, SETTLE), animate(y, s.top - stack.scrollTop + gap.offsetTop, SETTLE), animate(lean, 0, SETTLE)]);
      }
      // One commit: the gap becomes the card, in the same place, and the lifted one goes. Nothing else moves.
      const seq = ++moves;
      if (commit) setPending({ id: lift.id, ...target, seq });
      setLift(undefined);
      setOver(undefined);
      setSettling(false);
      setTimeout(() => (justDragged.current = false), 0);
      if (!commit) return;
      const { columns: cols, api: board, act: run } = latest.current;
      const items = cols.find((c) => c.status === target.status)?.items ?? [];
      await run(() => board.move(lift.id, target.status, neighbours(items, lift.id, target.index)));
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
    // Any scroll (the board sideways, a column up or down): scroll events don't bubble, so catch them on the way down.
    window.addEventListener('scroll', scrolled, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(tick);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scrolled, { capture: true });
    };
    // `over` is read once (the spot to start from); it's tracked inside after that.
  }, [lift, settling]);

  // While a card is up (and settling), the board's CSS transitions rest.
  useEffect(() => {
    if (!lift) return;
    document.documentElement.dataset.dragging = 'card';
    return () => void delete document.documentElement.dataset.dragging;
  }, [lift]);

  /** A press on a card: past a few pixels it's a drag, otherwise a click. */
  const press = useCallback((e: ReactPointerEvent<HTMLElement>, issue: Issue, index: number): void => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    const onMove = (m: PointerEvent): void => {
      // The button came up without us hearing it: no drag.
      if (!(m.buttons & 1)) return cleanup();
      if (!isDrag(m.clientX - start.x, m.clientY - start.y)) return;
      cleanup();
      const r = el.getBoundingClientRect();
      measure(issue.id);
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
  }, []);

  /** ⌥ and the arrows: the focused card to the next column, or up and down in its own. */
  const nudge = useCallback((issue: Issue, key: string): void => {
    const { columns: cols, statuses: all, api: board, act: run } = latest.current;
    const at = all.indexOf(issue.status);
    const col = cols.find((c) => c.status === issue.status)?.items ?? [];
    const here = col.findIndex((i) => i.id === issue.id);
    let target: Spot | undefined;
    if (key === 'ArrowLeft' && at > 0) target = { status: all[at - 1]!, index: 0 };
    if (key === 'ArrowRight' && at < all.length - 1) target = { status: all[at + 1]!, index: 0 };
    if (key === 'ArrowUp' && here > 0) target = { status: issue.status, index: here - 1 };
    if (key === 'ArrowDown' && here < col.length - 1) target = { status: issue.status, index: here + 1 };
    if (!target) return;
    const to = target;
    const items = cols.find((c) => c.status === to.status)?.items ?? [];
    const seq = ++moves;
    setPending({ id: issue.id, ...to, seq });
    void run(() => board.move(issue.id, to.status, neighbours(items, issue.id, to.index))).then(() => {
      setPending((p) => (p?.seq === seq ? undefined : p));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card="${issue.id}"] [role="button"]`)?.focus());
    });
  }, []);

  const register = useCallback((map: 'sections' | 'stacks', status: IssueStatus, el: HTMLElement | null): void => {
    const into = map === 'sections' ? sections.current : stacks.current;
    if (el) into.set(status, el);
    else into.delete(status);
  }, []);

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
      {columns.map(({ status, items }) => {
        const target = lift && over?.status === status;
        return (
          <Column
            key={status}
            status={status}
            items={items}
            {...(lift && lift.from === status ? { liftedId: lift.id } : {})}
            {...(target ? { gapAt: over.index, gapHeight: lift.height } : {})}
            reduce={reduce}
            {...(projectId ? { projectId } : {})}
            onPress={press}
            onNudge={nudge}
            suppressClick={justDragged}
            register={register}
            menu={menu}
            selfId={selfId}
            soloIn={soloIn}
          />
        );
      })}
      {lift && lifted
        ? createPortal(
            <motion.div className={t.cardLifted} style={{ x, y, width: lift.width, rotate: lean }} initial={reduce ? false : { scale: 1 }} animate={{ scale: settling ? 1 : 1.035 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} aria-hidden="true">
              <CardFace issue={lifted} selfId={selfId} solo={soloIn.split('\n').includes(lifted.projectId)} />
            </motion.div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * One status's column. Memoized: while a card is dragged only the columns it leaves and enters
 * render again, and motion only measures (and slides) the cards of the columns that rendered.
 */
const Column = memo(function Column({
  status,
  items,
  liftedId,
  gapAt,
  gapHeight,
  reduce,
  projectId,
  onPress,
  onNudge,
  suppressClick,
  register,
  menu,
  selfId,
  soloIn,
}: {
  status: IssueStatus;
  items: readonly Issue[];
  /** The card lifted out of this column, if it came from here. */
  liftedId?: string;
  /** Where the lifted card would land here, if it hovers this column. */
  gapAt?: number;
  gapHeight?: number;
  reduce: boolean;
  projectId?: string;
  onPress: (e: ReactPointerEvent<HTMLElement>, issue: Issue, index: number) => void;
  onNudge: (issue: Issue, key: string) => void;
  suppressClick: { current: boolean };
  register: (map: 'sections' | 'stacks', status: IssueStatus, el: HTMLElement | null) => void;
  menu: (issue: Issue) => ActionItem[];
  selfId: string;
  /** The projects you're alone on (who a task is for isn't shown there), one a line. */
  soloIn: string;
}) {
  const solo = soloIn.split('\n');
  const shown = withGap(items, liftedId, gapAt);
  const label = STATUS_INFO[status].label;
  let index = 0;
  return (
    <section ref={(el) => register('sections', status, el)} className={cx(t.column, gapAt !== undefined && t.columnOver)} role="listitem" aria-label={`${label}, ${items.length}`}>
      <header className={t.columnHead}>
        <StatusIcon status={status} />
        <span className={t.groupName}>{label}</span>
        <span className={t.groupCount}>{shown.length}</span>
        <span className={t.grow} />
        {status === 'in_plan' ? <PlanPrs issues={items} /> : null}
        {status === 'done' ? <ArchiveDoneButton projectId={projectId} /> : null}
        <IconButton icon="plus" label={`New Task in ${label}`} onClick={() => openSheet({ kind: 'new_task', status, ...(projectId ? { projectId } : {}) })} />
      </header>
      <div ref={(el) => register('stacks', status, el)} className={t.cards}>
        {shown.map((item) =>
          item === 'gap' ? (
            // No exit: on drop the gap is swapped for the card in one commit, so the cards below don't move.
            <motion.div
              key="gap"
              data-gap
              layout={!reduce}
              className={t.cardGap}
              style={{ height: gapHeight ?? 64 }}
              initial={reduce ? false : { opacity: 0, scaleY: 0.4 }}
              animate={{ opacity: 1, scaleY: 1 }}
              transition={SPRING}
            />
          ) : (
            <motion.div key={item.id} data-card={item.id} layout={reduce ? false : 'position'} transition={SPRING} className={t.cardSlot}>
              <Card issue={item} index={index++} onPress={onPress} onNudge={onNudge} suppressClick={suppressClick} menu={menu} selfId={selfId} solo={solo.includes(item.projectId)} />
            </motion.div>
          ),
        )}
        {!shown.length ? <div className={t.columnEmpty}>No tasks</div> : null}
      </div>
    </section>
  );
});

/** What a card shows (on the board, and lifted under the pointer). */
const CardFace = memo(function CardFace({ issue, selfId, solo }: { issue: Issue; selfId: string; solo: boolean }) {
  const self = useSelf();
  const epic = useApp((s) => isEpic(s.board, issue));
  return (
    <>
      <div className={t.cardTop}>
        <span className={t.key}>{issue.key}</span>
        {epic ? (
          <span className={t.epicTag}>
            <Icon name="epic" size={11} />
            Epic
          </span>
        ) : null}
        <span className={t.grow} />
        <WaitingMark issueId={issue.id} />
        <PriorityIcon priority={issue.priority} labelled />
        {solo ? null : <AssigneeMark assignee={issue.assignee} selfId={selfId} size={16} />}
      </div>
      <div className={cx(t.cardTitle, !STATUS_INFO[issue.status].open && t.titleClosed)}>{issue.title}</div>
      <IssueMeta issue={issue} compact progress={!epic} presence={false} />
      {epic ? <EpicBar issue={issue} /> : null}
      <OnItLine issue={issue} self={self} />
    </>
  );
});

const Card = memo(function Card({
  issue,
  index,
  onPress,
  onNudge,
  suppressClick,
  menu,
  selfId,
  solo,
}: {
  issue: Issue;
  /** Its place in its column. */
  index: number;
  onPress: (e: ReactPointerEvent<HTMLElement>, issue: Issue, index: number) => void;
  onNudge: (issue: Issue, key: string) => void;
  suppressClick: { current: boolean };
  menu: (issue: Issue) => ActionItem[];
  selfId: string;
  solo: boolean;
}) {
  const { open } = useTaskActions();
  const epic = useApp((s) => isEpic(s.board, issue));
  return (
    <ActionsContext items={() => menu(issue)}>
      <article
        className={cx(t.card, epic && t.cardEpic)}
        role="button"
        tabIndex={0}
        aria-label={`${issue.key} ${issue.title}`}
        {...taskDropProps(issue)}
        onPointerDown={(e) => onPress(e, issue, index)}
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
            onNudge(issue, e.key);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open(issue);
          }
        }}
      >
        <CardFace issue={issue} selfId={selfId} solo={solo} />
      </article>
    </ActionsContext>
  );
});

/** Merged into Plan waits for its plans' pull requests: a link to each once it's open. */
function PlanPrs({ issues }: { issues: readonly Issue[] }) {
  const { plans } = usePlans();
  const ids = new Set(issues.flatMap((i) => (i.plan ? [i.plan.id] : [])));
  const prs = plans.filter((p) => ids.has(p.id) && p.pr).map((p) => p.pr!);
  return (
    <>
      {prs.map((pr) => (
        <button key={pr.number} type="button" className={t.columnPr} title={`${pr.title} (${pr.state.toLowerCase()})`} onClick={() => void openExternal(pr.url)}>
          #{pr.number}
        </button>
      ))}
    </>
  );
}
