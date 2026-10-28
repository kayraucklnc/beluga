import { useMemo, useRef, useState } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { FIRST_SENTINEL_CHAT, sentinelChatOf, sentinelChatTitle } from '@beluga/core/sentinel/model.js';
import { activityOf } from '@beluga/ui/workspace-models.js';
import { Attention } from '../chat/Attention.js';
import { ChatLog } from '../chat/ChatLog.js';
import { Composer } from '../chat/Composer.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { Button, Empty, EmptyActions, IconButton, Tip } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { openSheet } from '../lib/sheets.js';
import { PickMenu } from '../tasks/PickMenu.js';
import { ResizeHandle, useWindowWidth } from '../layout/panel/ResizeHandle.js';
import { useSentinelActions } from './use-sentinel.js';
import v from '../views/views.module.css';
import s from './sentinel.module.css';
import home from './home.module.css';

/**
 * Ask Sentinel (docs/sentinel.md §12, BLG-306): one conversation with your own Claude for the whole
 * of Sentinel, docked beside Sentinel's page. It is the app's own chat (the conversation, its
 * approvals and questions, the message box), with a slim bar: the chat's name (a picker when there
 * are several), New Chat, ⋯ with Clear and Delete Chat…, and × to close the panel. Claude knows how
 * Sentinel works and sees it as it is; deleting a sentinel or a board asks you first, in the card
 * under the conversation (and on your phone).
 */

const STARTERS = [
  { label: 'Brief Me Every Morning', icon: 'clock', prompt: 'Every weekday morning, tell me what changed in my projects and what needs me first, on my phone.' },
  { label: 'Watch My Pull Requests', icon: 'branch', prompt: 'Set up a sentinel that counts my open pull requests every morning, and put the number on my board.' },
  { label: 'What Did They Find?', icon: 'sentinel', prompt: 'What did my sentinels find this week? Lead with anything that needs me.' },
] as const;

/** Ask Sentinel's width beside the page: dragged by its left edge, kept on this Mac. */
const WIDTH = 'sentinel.ask.width';
const WIDTH_DEFAULT = 380;
const WIDTH_MIN = 320;
const WIDTH_STEP = 24;
const readWidth = (): number => {
  try {
    const w = Number(localStorage.getItem(WIDTH));
    return Number.isFinite(w) && w > 0 ? w : WIDTH_DEFAULT;
  } catch {
    return WIDTH_DEFAULT;
  }
};
/** At most 60% of the window (and 760 pt), so the page beside it keeps room. */
const fitWidth = (w: number, windowWidth: number): number => Math.round(Math.max(WIDTH_MIN, Math.min(w, Math.min(760, windowWidth * 0.6))));

/** The panel Ask Sentinel docks in, on Sentinel's page and a sentinel's own: its left edge resizes it. */
export function AskPanel({ children }: { children: React.ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const windowWidth = useWindowWidth();
  const [width, setWidth] = useState(readWidth);
  const latest = useRef(width);
  const set = (w: number): void => {
    latest.current = w;
    setWidth(w);
  };
  const keep = (w: number = latest.current): void => {
    try {
      localStorage.setItem(WIDTH, String(fitWidth(w, window.innerWidth)));
    } catch {
      // Not kept: it still has this width now.
    }
  };
  return (
    <aside ref={panel} className={home.panel} style={{ width: fitWidth(width, windowWidth) }} aria-label="Ask Sentinel">
      <ResizeHandle
        axis="x"
        label="Resize Ask Sentinel"
        className={home.panelEdge}
        onMove={(x) => {
          const r = panel.current?.getBoundingClientRect();
          if (r) set(fitWidth(r.right - x, window.innerWidth));
        }}
        onEnd={() => keep()}
        onReset={() => {
          set(WIDTH_DEFAULT);
          keep(WIDTH_DEFAULT);
        }}
        onStep={(dir) => {
          const w = fitWidth(latest.current + dir * WIDTH_STEP, window.innerWidth);
          set(w);
          keep(w);
        }}
      />
      {children}
    </aside>
  );
}

export function SentinelChat({ onClose }: { onClose?: () => void }) {
  const view = useApp((st) => st.view);
  const channel = channelOf(view);
  // Opened beside a sentinel's own page: going between chats keeps that page.
  const about = view.kind === 'sentinel_chat' ? view.about : undefined;
  const here = about ? { about } : {};
  const id = sentinelChatOf(channel) ?? FIRST_SENTINEL_CHAT;
  const actions = useActions();
  const api = useApi();
  const a = useSentinelActions();
  const chats = useApp((st) => st.sentinel.chats?.chats ?? [], sameDeep);
  // The chats' names, from what you wrote first in each (picked as text, so streaming doesn't redraw the bar).
  const titles = useApp((st) => JSON.stringify(chats.map((c) => sentinelChatTitle(c.channel, st.log))));
  const names = useMemo(() => JSON.parse(titles) as string[], [titles]);
  const busy = useApp((st) => activityOf(st.log, channel).running);
  const has = useApp((st) => st.log.some((l) => l.channel === channel));
  const name = names[chats.findIndex((c) => c.id === id)] ?? 'New chat';
  const open = (chat: string): void => {
    void a.act(() => api.sentinel.chatOpen(chat));
    actions.run({ type: 'view', view: { kind: 'sentinel_chat', chat, ...here } });
  };
  const fresh = async (): Promise<void> => {
    const made = await a.act(() => api.sentinel.chatNew());
    if (made) actions.run({ type: 'view', view: { kind: 'sentinel_chat', chat: made.id, ...here } });
  };
  const more: ActionItem[] = [
    { label: 'New Chat', icon: 'plus', onSelect: () => void fresh() },
    { label: 'Clear', icon: 'x', hint: 'Its messages go, and Claude starts afresh; the chat stays', disabled: !has, separate: true, onSelect: () => void a.act(() => api.sentinel.chatClear(id), 'Cleared. Claude starts a fresh conversation here') },
    {
      label: 'Delete Chat…',
      danger: true,
      onSelect: () =>
        openSheet({
          kind: 'confirm',
          title: `Delete “${name}”?`,
          message: 'Its messages and Claude’s memory of it go for good. Your sentinels and dashboards stay as they are.',
          confirm: 'Delete Chat',
          destructive: true,
          run: () =>
            void a.act(() => api.sentinel.chatDelete(id), 'Deleted the chat').then(() => {
              // The one now open (the next, or a fresh first one) is shown.
              actions.run({ type: 'view', view: { kind: 'sentinel_chat', ...here } });
            }),
        }),
    },
  ];
  return (
    <div className={s.chatTab} data-sentinel-chat={id}>
      <div className={s.chatBar}>
        {onClose ? (
          <span className={s.chatTitle}>
            <Icon name="claude" size={13} />
            Ask Sentinel
          </span>
        ) : null}
        {chats.length > 1 ? (
          <PickMenu<string>
            label="Chats"
            choices={chats.map((c, i) => ({ value: c.id, label: names[i] ?? 'New chat', mark: <Icon name="chat" size={13} /> }))}
            chosen={[id]}
            onPick={open}
          >
            <button type="button" className={s.chatName} aria-label={`Chat: ${name}`}>
              <Icon name="chat" size={13} />
              <span>{name}</span>
              <Icon name="chevronDown" size={10} />
            </button>
          </PickMenu>
        ) : (
          <span className={s.chatName} data-single="">
            <Icon name="chat" size={13} />
            <span>{name}</span>
          </span>
        )}
        {busy ? <span className={s.chatBusy}>Claude is working</span> : null}
        <span className={s.grow} />
        <Tip label="A new conversation beside this one">
          <IconButton icon="plus" label="New Chat" onClick={() => void fresh()} />
        </Tip>
        <ActionsDropdown items={more}>
          <IconButton icon="more" label="More for this chat" />
        </ActionsDropdown>
        {onClose ? <IconButton icon="x" label="Close" onClick={onClose} /> : null}
      </div>
      <div className={v.chat} data-drop-zone>
        <ChatLog
          key={channel}
          channel={channel}
          empty={
            <Empty
              icon="sentinel"
              title="Ask Sentinel"
              detail="Say what to watch and Claude sets it up, paused for you to look over. It knows your sentinels, boards and numbers: ask what they found, change one, put something on the board. Deleting asks you first."
              action={
                <EmptyActions>
                  {STARTERS.map((t) => (
                    <Button key={t.label} icon={t.icon} onClick={() => actions.submit(t.prompt)}>
                      {t.label}
                    </Button>
                  ))}
                </EmptyActions>
              }
            />
          }
        />
        <Attention channel={channel} />
        <Composer />
      </div>
    </div>
  );
}
