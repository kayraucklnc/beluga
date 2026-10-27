import { useMemo } from 'react';
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
import { useSentinelActions } from './use-sentinel.js';
import v from '../views/views.module.css';
import s from './sentinel.module.css';

/**
 * Sentinel › Chat (docs/sentinel.md §12): one conversation with your own Claude for the whole of
 * Sentinel. It is the app's own chat (the conversation, its approvals and questions, the message
 * box), with a slim bar: the chat's name (a picker when there are several), New Chat, and ⋯ with
 * Clear and Delete Chat…. Claude knows how Sentinel works and sees it as it is; deleting a sentinel
 * or a dashboard asks you first, in the card under the conversation (and on your phone).
 */

const STARTERS = [
  { label: 'What Did They Find?', icon: 'sentinel', prompt: 'What did my sentinels find this week? Lead with anything that needs me.' },
  { label: 'Watch My Pull Requests', icon: 'branch', prompt: 'Set up a sentinel that counts my open pull requests every morning, and put the number on my dashboard.' },
  { label: 'Tidy the Dashboard', icon: 'gauge', prompt: 'Look at my dashboards and suggest how to arrange them better, then do it.' },
] as const;

export function SentinelChat() {
  const view = useApp((st) => st.view);
  const channel = channelOf(view);
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
    actions.run({ type: 'view', view: { kind: 'sentinel_chat', chat } });
  };
  const fresh = async (): Promise<void> => {
    const made = await a.act(() => api.sentinel.chatNew());
    if (made) actions.run({ type: 'view', view: { kind: 'sentinel_chat', chat: made.id } });
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
              actions.run({ type: 'view', view: { kind: 'sentinel_chat' } });
            }),
        }),
    },
  ];
  return (
    <div className={s.chatTab} data-sentinel-chat={id}>
      <div className={s.chatBar}>
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
          <Button size="small" icon="plus" onClick={() => void fresh()}>
            New Chat
          </Button>
        </Tip>
        <ActionsDropdown items={more}>
          <IconButton icon="more" label="More for this chat" />
        </ActionsDropdown>
      </div>
      <div className={v.chat} data-drop-zone>
        <ChatLog
          key={channel}
          channel={channel}
          empty={
            <Empty
              icon="sentinel"
              title="Talk to Sentinel"
              detail="Your Claude for all of Sentinel: it knows your sentinels, dashboards and numbers. Ask what they found, set up a new watcher, add a tile, change one. It makes and changes things without asking; deleting asks you first."
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
