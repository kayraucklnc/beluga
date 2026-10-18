import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogItem } from '@klaud/core/store.js';
import { Icon } from '../components/Icon.js';
import { Empty } from '../components/ui.js';
import { useApp } from '../lib/klaud.js';
import { Lightbox } from './ChatImages.js';
import { AgentCard, ChatRow, ShellCard, SystemRow } from './Items.js';
import s from './chat.module.css';

const GROUP_GAP_MS = 3 * 60_000;

/**
 * A conversation: virtualized (a long one stays fast), anchored to the bottom while you're at
 * the bottom, and left alone while you read further up (with a way back down).
 */
export function ChatLog({ channel, empty }: { channel: string; empty?: React.ReactNode }) {
  const log = useApp((st) => st.log);
  const selfId = useApp((st) => st.selfId);
  const items = useMemo(() => log.filter((l) => l.channel === channel), [log, channel]);
  const parent = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: (i) => (items[i]?.type === 'agent' ? 140 : items[i]?.type === 'system' ? 28 : 52),
    overscan: 8,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  // New messages (and Claude's streaming text) keep you at the bottom if that's where you were.
  useLayoutEffect(() => {
    if (stick.current && items.length) virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
  }, [items, virtualizer]);
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

  if (!items.length) return <div className={s.logEmpty}>{empty ?? <Empty icon="chat" title="Nothing here yet" detail="Say something below." />}</div>;

  const continued = (i: number): boolean => {
    const a = items[i - 1];
    const b = items[i];
    return Boolean(a && b && a.type === 'chat' && b.type === 'chat' && a.from === b.from && a.byAgent === b.byAgent && b.ts - a.ts < GROUP_GAP_MS);
  };

  return (
    <div className={s.logWrap}>
      <div ref={parent} className={s.log} onScroll={onScroll}>
        <div className={s.logInner} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = items[v.index] as LogItem;
            return (
              <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={s.logRow} style={{ transform: `translateY(${v.start}px)` }}>
                {item.type === 'chat' ? (
                  <ChatRow item={item} continued={continued(v.index)} mine={item.from === selfId} />
                ) : item.type === 'agent' ? (
                  <AgentCard item={item} />
                ) : item.type === 'shell' ? (
                  <ShellCard item={item} />
                ) : (
                  <SystemRow item={item} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {atBottom ? null : (
        <button
          type="button"
          className={s.jump}
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            virtualizer.scrollToIndex(items.length - 1, { align: 'end' });
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
