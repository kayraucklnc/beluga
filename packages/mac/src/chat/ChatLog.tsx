import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { asChatRow } from '../lib/said.js';
import type { LogItem } from '@klaud/core/store.js';
import { type TaskView, tasksIn } from '@klaud/core/gateway/model.js';
import { LogTaskCard } from '../gateway/TaskCard.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Empty, Working } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
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

function withTasks(items: readonly LogItem[], tasks: readonly TaskView[]): readonly Row[] {
  if (!tasks.length) return items;
  const rows: Row[] = [...items];
  for (const task of tasks) {
    const at = rows.findIndex((r) => r.ts > task.createdAt);
    rows.splice(at < 0 ? rows.length : at, 0, { type: 'task', id: `task:${task.id}`, ts: task.createdAt, task });
  }
  return rows;
}

/**
 * A conversation: virtualized (a long one stays fast), anchored to the bottom while you're at
 * the bottom, and left alone while you read further up (with a way back down).
 */
export function ChatLog({ channel, empty }: { channel: string; empty?: React.ReactNode }) {
  const log = useApp((st) => st.log);
  const selfId = useApp((st) => st.selfId);
  // A shared workspace's earlier messages arrive as system lines; drawn here as normal messages.
  const items = useMemo(() => log.filter((l) => l.channel === channel).map(asChatRow), [log, channel]);
  const gateway = useApp((st) => st.gateway);
  const tasks = useMemo(() => tasksIn({ gateway }, channel), [gateway, channel]);
  const rows = useMemo(() => withTasks(items, tasks), [items, tasks]);
  const parent = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (rows[i]?.type === 'agent' ? 140 : rows[i]?.type === 'task' ? 160 : rows[i]?.type === 'system' ? 28 : 52),
    overscan: 8,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  // Until Claude's card for the message you just sent appears.
  const cards = useMemo(() => items.filter((l) => l.type === 'agent').length, [items]);
  const starting = useClaudeStarting(channel, cards);

  // New messages (and Claude's streaming text) keep you at the bottom if that's where you were.
  useLayoutEffect(() => {
    if (stick.current && rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows, virtualizer]);
  useLayoutEffect(() => {
    const el = parent.current;
    if (starting && stick.current && el) el.scrollTop = el.scrollHeight;
  }, [starting]);
  // You sent a message: back to the newest, where it lands (see flight.ts).
  useEffect(() => {
    const toBottom = (): void => {
      stick.current = true;
      setAtBottom(true);
      if (rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    };
    document.addEventListener('klaud:chat-bottom', toBottom);
    return () => document.removeEventListener('klaud:chat-bottom', toBottom);
  }, [rows.length, virtualizer]);
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [channel]);

  const onScroll = (): void => {
    const el = parent.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
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
      <div ref={parent} className={s.log} onScroll={onScroll}>
        <div className={s.logInner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = rows[v.index] as Row;
            return (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={s.logRow} style={{ transform: `translateY(${v.start}px)` }}>
                {item.type === 'task' ? (
                  <LogTaskCard task={item.task} />
                ) : item.type === 'chat' ? (
                  <ChatRow item={item} continued={continued(v.index)} mine={item.from === selfId} />
                ) : item.type === 'agent' ? (
                  <AgentCard item={item} />
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
