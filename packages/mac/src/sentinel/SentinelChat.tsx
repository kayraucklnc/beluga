import { useEffect, useMemo, useRef, useState } from 'react';
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

type Starter = { readonly label: string; readonly icon: Parameters<typeof Icon>[0]['name']; readonly prompt: string };

/**
 * What to ask, when you don't know (BLG-333): first, Claude looks and suggests; then offers that
 * name your own projects; with sentinels already, what they found.
 */
function startersFor(projects: readonly string[], has: boolean): Starter[] {
  const [one, two] = projects;
  const all: Starter[] = [
    { label: 'Suggest Some for Me', icon: 'sparkles', prompt: 'Look at my projects and what they use, and suggest three watchers that would help me, each in one plain line. Set them up, with a board for their numbers, when I say yes.' },
    ...(has ? [{ label: 'What Did They Find?', icon: 'sentinel', prompt: 'What did my sentinels find this week? Lead with anything that needs me.' } satisfies Starter] : []),
    one
      ? ({ label: `A Morning Brief for ${one}`, icon: 'clock', prompt: `Every weekday morning, tell me on my phone what changed in ${one} and what needs me first.` } satisfies Starter)
      : ({ label: 'A Morning Brief', icon: 'clock', prompt: 'Every weekday morning, tell me on my phone what changed and what needs me first.' } satisfies Starter),
    ...(two ? [{ label: `Fix ${two}’s Failing Tests`, icon: 'wrench', prompt: `When the tests fail on GitHub for ${two}, have the agent fix it in a new worktree and open a pull request for me to merge.` } satisfies Starter] : []),
    { label: 'Make Me a Board', icon: 'gauge', prompt: 'Make me a board with the numbers that matter for my projects, and set up what keeps them fresh.' },
  ];
  return all.slice(0, 4);
}

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

/**
 * When the panel last went: going from Sentinel's page to a sentinel's (it docks again at once)
 * doesn't slide it in again; opening it after it was closed does.
 */
let closedAt = 0;
const REDOCK_MS = 600;

/**
 * The panel Ask Sentinel docks in, on Sentinel's page and a sentinel's own: its left edge resizes
 * it. Opened (you asked from the page's own box, or Ask Claude), it slides in from the right, the
 * page making room, and the conversation goes on there.
 */
export function AskPanel({ children }: { children: React.ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const [opening, setOpening] = useState(() => Date.now() - closedAt > REDOCK_MS);
  useEffect(() => () => void (closedAt = Date.now()), []);
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
    <aside ref={panel} className={home.panel} data-opening={opening || undefined} onAnimationEnd={(e) => e.target === e.currentTarget && setOpening(false)} style={{ width: fitWidth(width, windowWidth) }} aria-label="Ask Sentinel">
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
      {/* Its own width while it slides in, so the chat doesn't squeeze and re-wrap on the way. */}
      <div className={home.panelInner} style={{ width: fitWidth(width, windowWidth) }}>
        {children}
      </div>
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
  const projectNames = useApp((st) => st.projects.filter((p) => p.root && !p.error).map((p) => p.name).join('\n'));
  const hasSentinels = useApp((st) => st.sentinel.items.length > 0);
  const starters = useMemo(() => startersFor(projectNames ? projectNames.split('\n') : [], hasSentinels), [projectNames, hasSentinels]);
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
    { label: 'Clear', icon: 'x', hint: 'Its messages go, and the agent starts afresh; the chat stays', disabled: !has, separate: true, onSelect: () => void a.act(() => api.sentinel.chatClear(id), 'Cleared. The agent starts a fresh conversation here') },
    {
      label: 'Delete Chat…',
      danger: true,
      onSelect: () =>
        openSheet({
          kind: 'confirm',
          title: `Delete “${name}”?`,
          message: 'Its messages and the agent’s memory of it go for good. Your sentinels and dashboards stay as they are.',
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
            <span className={s.chatTitleText}>Ask Sentinel</span>
          </span>
        ) : null}
        {/* Always the picker (with New Chat in it), so going between chats never hides behind ⋯. */}
        <PickMenu<string>
          label="Chats"
          choices={chats.map((c, i) => ({ value: c.id, label: names[i] ?? 'New chat', mark: <Icon name="chat" size={13} /> }))}
          chosen={[id]}
          onPick={open}
          actions={[{ label: 'New Chat', icon: 'plus', onSelect: () => void fresh() }]}
        >
          <button type="button" className={s.chatName} aria-label={`Chat: ${name}`}>
            {onClose ? null : <Icon name="chat" size={13} />}
            <span>{name}</span>
            <Icon name="chevronDown" size={10} />
          </button>
        </PickMenu>
        {busy ? <span className={s.chatBusy}>Your agent is working</span> : null}
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
              detail="Say what you’d like watched, in your own words, or let your agent look at your projects and suggest."
              action={
                <EmptyActions>
                  {starters.map((t) => (
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
