import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { asChatRow } from '../lib/said.js';
import { backgroundWait } from '@beluga/shared/claude-notices.js';
import type { LogItem } from '@beluga/core/store.js';
import { type TaskView, tasksIn } from '@beluga/core/gateway/model.js';
import { LogTaskCard } from '../gateway/TaskCard.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Dot, Empty, Working } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { keepSameLists, sameItems } from '../lib/stable.js';
import { Lightbox } from './ChatImages.js';
import { FindBar } from './FindBar.js';
import { AgentCard, ChatRow, ShellCard, SystemRow } from './Items.js';
import { CompactDivider } from './CompactDivider.js';
import { isCompactItem } from './context-model.js';
import { useClaudeStarting } from './flight.js';
import s from './chat.module.css';
import f from './flight.module.css';

const GROUP_GAP_MS = 3 * 60_000;

/** A task your Claude sent from this conversation (to another person's Claude), drawn where it was asked. */
type TaskRow = { readonly type: 'task'; readonly id: string; readonly ts: number; readonly task: TaskView };
type Row = LogItem | TaskRow;

/**
 * Tasks your Claude sent during one of its turns belong to that turn: drawn inside its card,
 * after its steps and before its answer (you asked → their Claude worked → your Claude's answer,
 * last). Others (sent by you, or outside a turn) are rows of their own, in time order.
 */
export function placeTasks(items: readonly LogItem[], tasks: readonly TaskView[]): { rows: readonly Row[]; inTurn: ReadonlyMap<string, readonly TaskView[]> } {
  const inTurn = new Map<string, TaskView[]>();
  if (!tasks.length) return { rows: items, inTurn };
  const loose: TaskView[] = [];
  const turns = items.filter((l): l is Extract<LogItem, { type: 'agent' }> => l.type === 'agent');
  for (const task of tasks) {
    const turn = task.by === 'agent' ? turns.filter((t) => t.ts <= task.createdAt && (t.endTs === undefined || t.endTs >= task.createdAt)).at(-1) : undefined;
    if (turn) inTurn.set(turn.id, [...(inTurn.get(turn.id) ?? []), task]);
    else loose.push(task);
  }
  return { rows: withTasks(items, loose), inTurn };
}

function withTasks(items: readonly LogItem[], tasks: readonly TaskView[]): readonly Row[] {
  if (!tasks.length) return items;
  const rows: Row[] = [...items];
  for (const task of tasks) {
    const at = rows.findIndex((r) => r.ts > task.createdAt);
    rows.splice(at < 0 ? rows.length : at, 0, { type: 'task', id: `task:${task.id}`, ts: task.createdAt, task });
  }
  return rows;
}

/** A shared workspace's earlier message (a system line) as the chat row it's drawn as: the same row each time, so its memo holds. */
const chatRows = new WeakMap<LogItem, LogItem>();
function chatRowOf(item: LogItem): LogItem {
  if (item.type !== 'system' || !item.said) return item;
  let row = chatRows.get(item);
  if (!row) chatRows.set(item, (row = asChatRow(item)));
  return row;
}

/** The newest Claude card of a conversation's items. */
export function latestCard(items: readonly LogItem[]): string | undefined {
  return items.findLast((l) => l.type === 'agent')?.id;
}

/**
 * A conversation: virtualized (a long one stays fast), anchored to the bottom while you're at
 * the bottom, and left alone while you read further up (with a way back down).
 */
export function ChatLog({ channel, empty }: { channel: string; empty?: React.ReactNode }) {
  // Only this conversation's items and tasks: another one streaming doesn't draw this one again (KLD-48).
  const mine = useApp((st) => st.log.filter((l) => l.channel === channel), sameItems);
  const selfId = useApp((st) => st.selfId);
  // A shared workspace's earlier messages arrive as system lines; drawn here as normal messages.
  const items = useMemo(() => mine.map(chatRowOf), [mine]);
  const tasks = useApp((st) => tasksIn(st, channel), sameItems);
  const placed = useMemo(() => placeTasks(items, tasks), [items, tasks]);
  // A card's tasks stay the same list while they're the same tasks, so its memo holds.
  const turnTasks = useRef<ReadonlyMap<string, readonly TaskView[]>>(undefined);
  const inTurn = useMemo(() => (turnTasks.current = keepSameLists(turnTasks.current, placed.inTurn)), [placed]);
  const rows = placed.rows;
  const latest = useMemo(() => latestCard(items), [items]);
  const parent = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const height = useRef(0);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (rows[i]?.type === 'agent' ? 140 : rows[i]?.type === 'task' ? 160 : rows[i]?.type === 'system' ? 28 : 52),
    overscan: 8,
    getItemKey: (i) => rows[i]?.id ?? i,
    // A row that grows or shrinks (a new step under Claude, its answer streaming in) moves the
    // rows below it and the list's height in the same frame, straight from the resize: waiting
    // for a React render painted one frame with the old layout (the new line overlapping the
    // next row, or below the bottom and then jumping up), which flickered.
    directDomUpdates: true,
    // In that same frame, stay at the bottom if that's where you were.
    onChange: (v) => {
      const total = v.getTotalSize();
      if (total === height.current) return;
      height.current = total;
      const el = parent.current;
      if (stick.current && el) el.scrollTop = el.scrollHeight;
    },
  });

  // Until Claude's card for the message you just sent appears.
  const cards = useMemo(() => items.filter((l) => l.type === 'agent').length, [items]);
  const starting = useClaudeStarting(channel, cards);
  const waiting = useMemo(() => backgroundWait(items), [items]);

  // New messages (and Claude's streaming text) keep you at the bottom if that's where you were.
  useLayoutEffect(() => {
    if (stick.current && rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows, virtualizer]);
  useLayoutEffect(() => {
    const el = parent.current;
    if ((starting || waiting) && stick.current && el) el.scrollTop = el.scrollHeight;
  }, [starting, waiting]);
  // You sent a message: back to the newest, where it lands (see flight.ts).
  useEffect(() => {
    const toBottom = (): void => {
      stick.current = true;
      setAtBottom(true);
      if (rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    };
    document.addEventListener('beluga:chat-bottom', toBottom);
    return () => document.removeEventListener('beluga:chat-bottom', toBottom);
  }, [rows.length, virtualizer]);
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [channel]);

  // Only you scrolling (wheel, trackpad, keys, the scroll bar) leaves the bottom; the list moving
  // itself (a tall row measured, a graph laid out) doesn't.
  const youScrolled = useRef(0);
  const markScroll = (): void => {
    youScrolled.current = Date.now();
  };
  const onScroll = (): void => {
    const el = parent.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (!bottom && stick.current && Date.now() - youScrolled.current > 400) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };

  if (!rows.length) {
    return (
      <div className={s.logWrap}>
        <FindBar items={items} logRef={parent} onGo={() => undefined} />
        <div className={s.logEmpty}>{empty ?? <Empty icon="chat" title="Nothing here yet" detail="Say something below." />}</div>
      </div>
    );
  }

  const continued = (i: number): boolean => {
    const a = rows[i - 1];
    const b = rows[i];
    return Boolean(a && b && a.type === 'chat' && b.type === 'chat' && a.from === b.from && a.byAgent === b.byAgent && b.ts - a.ts < GROUP_GAP_MS);
  };

  const go = (index: number): void => {
    stick.current = false;
    const id = items[index]?.id;
    virtualizer.scrollToIndex(Math.max(0, rows.findIndex((r) => r.id === id)), { align: 'center' });
  };

  return (
    <div className={s.logWrap} data-flight-layer="">
      <FindBar items={items} logRef={parent} onGo={go} />
      <div ref={parent} className={s.log} onScroll={onScroll} onWheel={markScroll} onTouchMove={markScroll} onPointerDown={markScroll} onKeyDown={markScroll}>
        {/* The virtualizer sets the list's height and each row's position itself (see above). */}
        <div ref={virtualizer.containerRef} className={s.logInner}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = rows[v.index] as Row;
            return (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={s.logRow}>
                {item.type === 'task' ? (
                  <LogTaskCard task={item.task} />
                ) : item.type === 'chat' ? (
                  <ChatRow item={item} continued={continued(v.index)} mine={item.from === selfId} />
                ) : item.type === 'agent' ? (
                  <AgentCard item={item} tasks={inTurn.get(item.id)} latest={item.id === latest} />
                ) : item.type === 'shell' ? (
                  <ShellCard item={item} />
                ) : isCompactItem(item) ? (
                  <CompactDivider item={item} />
                ) : (
                  <SystemRow item={item} />
                )}
              </div>
            );
          })}
        </div>
        {starting ? (
          <div className={f.starting} data-claude-starting="true" role="status">
            <span className={f.startingAvatar}>
              <Avatar name="Claude" id={selfId} claude size={22} />
            </span>
            <Working />
            <span>Claude is starting…</span>
          </div>
        ) : waiting ? (
          // Its results come back to Claude, which then goes on here.
          <div className={f.starting} data-background-wait="true" role="status" title={waiting}>
            <span className={f.startingAvatar}>
              <Dot tone="claude" live />
            </span>
            <span className={f.waitText}>{waiting}</span>
          </div>
        ) : null}
      </div>
      {atBottom ? null : (
        <button
          type="button"
          className={s.jump}
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
          }}
        >
          <Icon name="chevronDown" size={12} />
          Latest
        </button>
      )}
      <Lightbox />
    </div>
  );
}
