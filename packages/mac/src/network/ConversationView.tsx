import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FriendView, GroupView, MessageView } from '@klaud/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Avatar, Button, Empty, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useKlaud } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { Markdown } from '../chat/Markdown.js';
import { plainText } from '../chat/message-menu.js';
import { GroupAvatar, PersonAvatar } from './Avatars.js';
import { NetComposer, QUOTE_EVENT } from './NetComposer.js';
import { continues, conversationOf, dayLabel, membersLine, mergeMessages, presenceLine, sameDay, shownState } from './net-model.js';
import { openNet } from './net-sheets.js';
import { errorText, quietly, useNetwork, useSay } from './use-net.js';
import chat from '../chat/chat.module.css';
import s from './network.module.css';

/** Messages the shared state keeps per conversation; with that many, there may be earlier ones. */
const KEPT = 200;
const PAGE = 100;

const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fullTime = (ts: number): string => new Date(ts).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function messageItems(m: MessageView, ctx: { say: (t: string) => void; resend?: () => void }): ActionItem[] {
  if (m.status === 'locked') return [];
  const copy = (text: string, what: string): void => void copyText(text).then(() => ctx.say(`Copied ${what}`));
  return [
    ...(ctx.resend ? [{ label: 'Send Again', icon: 'refresh' as const, onSelect: ctx.resend }] : []),
    { label: 'Copy', icon: 'copy', separate: Boolean(ctx.resend), onSelect: () => copy(plainText(m.text), 'the message') },
    { label: 'Copy as Markdown', onSelect: () => copy(m.text, 'as Markdown') },
    { label: 'Quote in Reply', icon: 'chat', separate: true, onSelect: () => document.dispatchEvent(new CustomEvent(QUOTE_EVENT, { detail: m.text })) },
  ];
}

/** One message: the room chat's look; your own say whether they're waiting to be delivered. */
const Message = memo(function Message({ m, continued, dm, last, resend, me }: { m: MessageView; continued: boolean; dm: boolean; last: boolean; resend: (m: MessageView) => void; me?: { name: string; peerId: string } }) {
  const prefs = usePrefs();
  const say = useSay();
  const locked = m.status === 'locked';
  const expired = m.mine && m.status === 'expired';
  return (
    <ActionsContext items={() => messageItems(m, { say, ...(expired ? { resend: () => resend(m) } : {}) })}>
      <div className={cx(chat.message, continued && chat.continued, m.mine && s.mine, m.status === 'waiting' && s.waiting)} data-message={m.id}>
        <div className={chat.gutter}>{continued ? null : <Avatar name={m.mine && me ? me.name : m.name} id={m.mine && me ? me.peerId : m.from} size={26} />}</div>
        <div className={chat.body} title={fullTime(m.ts)}>
          {continued ? null : (
            <div className={chat.meta}>
              <span className={chat.author}>{m.mine ? 'You' : m.name}</span>
              {prefs.timestamps ? <span className={chat.time}>{time(m.ts)}</span> : null}
            </div>
          )}
          {locked ? (
            <div className={s.locked}>
              <Icon name="lock" size={12} />
              Can’t be read on this Mac
            </div>
          ) : (
            <Markdown text={m.text} />
          )}
          {m.mine && m.status === 'waiting' ? (
            <div className={s.state}>
              <Icon name="clock" size={11} />
              Waiting to be delivered
            </div>
          ) : expired ? (
            <div className={cx(s.state, s.stateExpired)}>
              <Icon name="alert" size={11} />
              Not delivered.
              <button type="button" onClick={() => resend(m)}>
                Send Again
              </button>
            </div>
          ) : dm && last && m.mine && m.status === 'delivered' ? (
            <div className={s.state}>Delivered</div>
          ) : null}
        </div>
      </div>
    </ActionsContext>
  );
});

/** The start of a conversation: who it's with, and that it stays between you. */
function Intro({ friend, group }: { friend?: FriendView; group?: GroupView }) {
  if (friend) {
    return (
      <div className={s.intro}>
        <PersonAvatar name={friend.name} id={friend.peerId} state={shownState(friend)} size={64} />
        <div className={s.introName}>{friend.name}</div>
        <div className={s.introLine}>{presenceLine(friend)}</div>
        <div className={s.introPrivacy}>
          <Icon name="lock" size={12} />
          End-to-end encrypted, straight to {friend.name}’s Mac
        </div>
      </div>
    );
  }
  if (!group) return null;
  return (
    <div className={s.intro}>
      <GroupAvatar name={group.name} id={group.id} size={64} />
      <div className={s.introName}>{group.name}</div>
      <div className={s.introLine}>{membersLine(group.members)}</div>
      <div className={s.introPrivacy}>
        <Icon name="lock" size={12} />
        End-to-end encrypted, kept on each member’s Mac
      </div>
      {group.admin && group.active ? (
        <div className={s.introActions}>
          <Button icon="plus" onClick={() => openNet({ kind: 'add_people', groupId: group.id })}>
            Add People…
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Keeps the log at the bottom while you're there; leaves it alone while you read further up. */
function useStickToBottom(dep: unknown, key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    stick.current = true;
  }, [key]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep, key]);
  const onScroll = (): void => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  return { ref, onScroll };
}

/** A conversation with a friend (`dm:<peerId>`) or a group (`group:<id>`). */
export function ConversationView({ id }: { id: string }) {
  const { client } = useKlaud();
  const net = useNetwork();
  const target = conversationOf(id);
  const friend = target?.kind === 'dm' ? net.friends.find((f) => f.peerId === target.peerId) : undefined;
  const group = target?.kind === 'group' ? net.groups.find((g) => g.id === target.groupId) : undefined;
  const latest = net.messages[id] ?? [];
  const [earlier, setEarlier] = useState<{ id: string; list: readonly MessageView[]; more: boolean }>({ id, list: [], more: true });
  const older = earlier.id === id ? earlier : { id, list: [], more: true };
  const messages = useMemo(() => mergeMessages(older.list, latest), [older.list, latest]);
  const more = latest.length >= KEPT && older.more;
  const { ref, onScroll } = useStickToBottom(messages, id);

  if (!net.enabled) {
    return (
      <Empty
        icon="people"
        title="Talking with friends is off"
        detail="Turn it on to see your friends and groups."
        action={
          <Button variant="primary" onClick={() => void client.api.network.setEnabled(true)}>
            Turn On
          </Button>
        }
      />
    );
  }
  if (!target || (!friend && !group)) {
    return <Empty icon="people" title={target?.kind === 'group' ? 'This group isn’t here any more' : 'Not a friend any more'} detail="Its messages stay on this Mac, but you can’t write here." />;
  }

  const loadEarlier = async (): Promise<void> => {
    const first = messages[0];
    if (!first) return;
    try {
      const page = target.kind === 'dm' ? await quietly(client, client.api.network['dm.history'](target.peerId, { before: first.ts, limit: PAGE })) : await quietly(client, client.api.network['groups.history'](target.groupId, { before: first.ts, limit: PAGE }));
      setEarlier({ id, list: [...page, ...older.list], more: page.length >= PAGE });
    } catch (err) {
      client.store.dispatch({ type: 'toast', text: `Couldn’t load earlier messages: ${errorText(err)}`, level: 'error' });
    }
  };
  const send = (text: string): Promise<unknown> => (target.kind === 'dm' ? client.api.network['dm.send'](target.peerId, text) : client.api.network['groups.send'](target.groupId, text));
  const resend = (m: MessageView): void => void send(m.text).catch(() => undefined);
  const lastMine = [...messages].reverse().find((m) => m.mine)?.id;

  return (
    <div className={s.conversation}>
      <div ref={ref} className={s.log} onScroll={onScroll} role="log" aria-label={friend ? `Conversation with ${friend.name}` : `Group ${group?.name ?? ''}`}>
        {more ? (
          <div className={s.earlier}>
            <button type="button" onClick={() => void loadEarlier()}>
              Show Earlier Messages
            </button>
          </div>
        ) : (
          <Intro {...(friend ? { friend } : {})} {...(group ? { group } : {})} />
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.ts, m.ts);
          return (
            <div key={m.id}>
              {newDay ? <div className={s.day}>{dayLabel(m.ts)}</div> : null}
              <Message m={m} continued={!newDay && continues(prev, m)} dm={target.kind === 'dm'} last={m.id === lastMine} resend={resend} {...(net.self ? { me: net.self } : {})} />
            </div>
          );
        })}
      </div>
      {group && !group.active ? (
        <div className={s.closed}>
          <div className={s.closedBox}>
            <Icon name="lock" size={13} />
            <span>You’re no longer in {group.name}. Its messages stay here, read-only.</span>
          </div>
        </div>
      ) : (
        <NetComposer id={id} placeholder={friend ? `Message ${friend.name}` : `Message ${group?.name ?? 'the group'}`} send={send} />
      )}
    </div>
  );
}
