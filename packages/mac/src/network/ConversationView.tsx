import { type ReactElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FriendView, GroupView, MessageView } from '@beluga/net/mesh/views.js';
import type { MentionWorld } from '../chat/mentions.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsContext } from '../components/SpecMenu.js';
import { Avatar, Button, Empty, claudeColor, cx } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { LogTaskCard } from '../gateway/TaskCard.js';
import { Attention } from '../chat/Attention.js';
import { isFinal } from '@beluga/core/gateway/model.js';
import { usePrefs } from '../lib/prefs.js';
import { Markdown } from '../chat/Markdown.js';
import { plainText } from '../chat/message-menu.js';
import { GroupAvatar, PersonAvatar } from './Avatars.js';
import { ASK_EVENT, NetComposer, type Outgoing, QUOTE_EVENT } from './NetComposer.js';
import { MessageFiles } from './ChatFiles.js';
import { ChatTabs } from './ChatTabs.js';
import { addBlobs, addPaths } from './attachments.js';
import { askedLine, authorLabel, channelName, channelWorld, isMain, liveIn, liveLine } from './chat-model.js';
import { continues, conversationOf, dayLabel, membersLine, mergeMessages, presenceLine, sameDay, shownState } from './net-model.js';
import { openNet } from './net-sheets.js';
import { errorText, quietly, useNetwork, useSay } from './use-net.js';
import { inApp } from '../lib/boot.js';
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
  const quote = (): void => void document.dispatchEvent(new CustomEvent(QUOTE_EVENT, { detail: m.text }));
  return [
    ...(ctx.resend ? [{ label: 'Send Again', icon: 'refresh' as const, onSelect: ctx.resend }] : []),
    ...(m.text.trim()
      ? [
          { label: 'Copy', icon: 'copy' as const, separate: Boolean(ctx.resend), onSelect: () => copy(plainText(m.text), 'the message') },
          { label: 'Copy as Markdown', onSelect: () => copy(m.text, 'as Markdown') },
          { label: 'Quote in Reply', icon: 'chat' as const, separate: true, onSelect: quote },
          {
            label: 'Ask Claude About This',
            icon: 'claude' as const,
            onSelect: () => {
              quote();
              document.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { kind: 'me' } }));
            },
          },
        ]
      : []),
  ];
}

/** One message: the room chat's look; your own say whether they're waiting to be delivered. */
const Message = memo(function Message({ m, continued, dm, last, resend, me, nameOf, world, offer }: { m: MessageView; continued: boolean; dm: boolean; last: boolean; resend: (m: MessageView) => void; me?: { name: string; peerId: string }; nameOf: (peerId: string) => string; world: MentionWorld; offer?: boolean }) {
  const prefs = usePrefs();
  const say = useSay();
  const locked = m.status === 'locked';
  const expired = m.mine && m.status === 'expired';
  const asked = askedLine(m, nameOf, me?.peerId);
  const deliveryState =
    m.mine && m.status === 'waiting' ? (
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
    ) : null;
  // Your own words (not your Claude's): a tinted bubble on the right, no name or picture, as in the room's chat.
  if (m.mine && !m.claude && !locked)
    return (
      <ActionsContext items={() => messageItems(m, { say, ...(expired ? { resend: () => resend(m) } : {}) })}>
        <div className={cx(chat.message, chat.own, continued && chat.continued, m.status === 'waiting' && s.waiting)} data-message={m.id} data-mine="true">
          <div className={chat.body} title={fullTime(m.ts)}>
            {m.text.trim() ? (
              <div className={chat.bubble}>
                <Markdown text={m.text} mentions={world} />
              </div>
            ) : null}
            {m.files?.length ? <MessageFiles files={m.files} conversation={m.conversation} mine /> : null}
            {asked ? (
              <div className={s.asked}>
                <Icon name="claude" size={11} />
                {asked}
              </div>
            ) : null}
            {deliveryState}
          </div>
        </div>
      </ActionsContext>
    );
  return (
    <ActionsContext items={() => messageItems(m, { say, ...(expired ? { resend: () => resend(m) } : {}) })}>
      <div className={cx(chat.message, continued && chat.continued, m.mine && s.mine, m.claude && s.claudeMsg, m.status === 'waiting' && s.waiting)} data-message={m.id} data-claude={m.claude ? 'true' : undefined}>
        <div className={chat.gutter}>{continued ? null : <Avatar name={m.mine && me ? me.name : m.name} id={m.mine && me ? me.peerId : m.from} size={26} claude={Boolean(m.claude)} />}</div>
        <div className={chat.body} title={fullTime(m.ts)}>
          {continued ? null : (
            <div className={chat.meta}>
              <span className={cx(chat.author, m.claude && s.claudeAuthor)} style={m.claude ? { color: claudeColor(m.mine && me ? me.peerId : m.from) } : undefined}>
                {authorLabel(m)}
              </span>
              {m.claude ? <span className={s.claudeTag}>on {m.mine ? 'your' : `${m.name}’s`} Mac</span> : null}
              {prefs.timestamps ? <span className={chat.time}>{time(m.ts)}</span> : null}
            </div>
          )}
          {locked ? (
            <div className={s.locked}>
              <Icon name="lock" size={12} />
              Can’t be read on this Mac
            </div>
          ) : (
            <>
              {m.text.trim() ? <Markdown text={m.text} mentions={world} /> : null}
              {m.files?.length ? <MessageFiles files={m.files} conversation={m.conversation} mine={m.mine} /> : null}
              {asked ? (
                <div className={s.asked}>
                  <Icon name="claude" size={11} />
                  {asked}
                </div>
              ) : null}
              {offer ? <RequestOffer m={m} /> : null}
            </>
          )}
          {deliveryState}
        </div>
      </div>
    </ActionsContext>
  );
});

/** Which answers you sent as requests (message id → task id), so the card stays under the answer. */
const SENT_KEY = 'beluga.chat-requests';
const sentRequests = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SENT_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};
const rememberSent = (message: string, task: string): void => {
  const all = Object.entries({ ...sentRequests(), [message]: task }).slice(-200);
  localStorage.setItem(SENT_KEY, JSON.stringify(Object.fromEntries(all)));
};

/**
 * A friend's Claude can't touch their Mac from a chat; when what you asked needs it, its answer
 * offers the real thing: a request to their Claude on their Mac (the gateway), which their trust
 * settings let in or they approve. Once sent, the request's card follows it here.
 */
function RequestOffer({ m }: { m: MessageView }) {
  const { client } = useBeluga();
  const say = useSay();
  const [sending, setSending] = useState(false);
  const [taskId, setTaskId] = useState<string | undefined>(() => sentRequests()[m.id]);
  const task = useApp((st) => (taskId ? st.gateway.tasks.find((t) => t.id === taskId) : undefined));
  const request = m.claude?.request;
  if (!request) return null;
  if (task) return <LogTaskCard task={task} />;
  if (taskId) return <div className={s.asked}>Sent as a request to {m.name}’s Mac</div>;
  const send = (): void => {
    setSending(true);
    void client.api.gateway
      .ask(m.from, request.ask, request.needs?.length ? { needs: [...request.needs] } : undefined)
      .then((t) => {
        rememberSent(m.id, t.id);
        setTaskId(t.id);
      })
      .catch((err: unknown) => say(`Couldn’t send it: ${errorText(err)}`))
      .finally(() => setSending(false));
  };
  return (
    <div className={s.requestOffer}>
      <span className={s.requestAsk}>
        <Icon name="send" size={11} />
        {request.ask}
      </span>
      <Button size="small" variant="primary" disabled={sending} onClick={send}>
        {sending ? 'Sending…' : `Ask on ${m.name}’s Mac`}
      </Button>
    </div>
  );
}

/**
 * A task between two people's Claudes (BLG-208): both of them see its card here, drawn from their
 * own Mac's task book, so it moves along (sent, waiting for approval, working, the result). Someone
 * else in the channel has no such task: they see the message's words, the request's summary.
 */
function TaskMessage({ id, plain }: { id: string; plain: ReactElement }) {
  const task = useApp((st) => st.gateway.tasks.find((t) => t.id === id));
  return task ? <LogTaskCard task={task} inChat /> : plain;
}

/** The start of a conversation: who it's with, and that it stays between you. */
function Intro({ friend, group }: { friend?: FriendView; group?: GroupView }) {
  const net = useNetwork();
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
      <div className={s.introName}>{channelName(net, group)}</div>
      <div className={s.introLine}>{isMain(net, group) ? `Your main channel: all your friends, and everyone you add later · ${membersLine(group.members)}` : membersLine(group.members)}</div>
      <div className={s.introPrivacy}>
        <Icon name="lock" size={12} />
        End-to-end encrypted, kept on each member’s Mac
      </div>
      <div className={s.introHint}>
        Drop files here to share them straight from your Mac. Claude answers only when you ask: type <b>@claude</b>, or click <b>Add Claude</b> under the message box.
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

/** Claudes answering right now: "bob’s Claude is answering…" with the typing dots. */
function LiveRow({ id, me }: { id: string; me?: string }) {
  const net = useNetwork();
  const [, tick] = useState(0);
  const live = liveIn(net, id);
  // Stale ones drop out by themselves (a Claude that went quiet).
  useEffect(() => {
    if (!live.length) return;
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [live.length]);
  if (!live.length) return null;
  return (
    <div className={s.live} role="status" aria-live="polite">
      <span className={s.liveAvatars}>
        {live.slice(0, 3).map((l) => (
          <Avatar key={`${l.peerId}:${l.for}`} name={l.name} id={l.peerId} size={18} claude />
        ))}
      </span>
      <span>{liveLine(live, me)}</span>
      <span className={s.dots} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

/** Files dropped anywhere on the conversation go in the message box (Finder files by path; a browser's by bytes). */
function useFileDrop(id: string, enabled: boolean) {
  const { client } = useBeluga();
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!inApp() || !enabled) return;
    let off: (() => void) | undefined;
    let alive = true;
    const inside = (x: number, y: number): boolean => {
      const r = ref.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return !!r && x / scale >= r.left && x / scale <= r.right && y / scale >= r.top && y / scale <= r.bottom;
    };
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === 'leave') return setOver(false);
        const here = inside(p.position.x, p.position.y);
        if (p.type === 'drop') {
          setOver(false);
          if (here && p.paths.length) void addPaths(client, id, p.paths);
        } else setOver(here);
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [id, enabled]);
  const html = {
    onDragOver: (e: React.DragEvent) => {
      if (inApp() || !enabled || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (inApp() || !enabled) return;
      e.preventDefault();
      setOver(false);
      const files = [...e.dataTransfer.files];
      if (files.length) void addBlobs(client, id, files);
    },
  };
  return { ref, over, html };
}

/** A conversation with a friend (`dm:<peerId>`) or a group (`group:<id>`), with the chat tabs above it. */
export function ConversationView({ id }: { id: string }) {
  const net = useNetwork();
  if (!net.enabled) return <Conversation id={id} />;
  return (
    <div className={s.chatArea}>
      <ChatTabs shown={id} />
      <Conversation id={id} />
    </div>
  );
}

function Conversation({ id }: { id: string }) {
  const { client } = useBeluga();
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
  const writable = Boolean(friend || group?.active);
  const drop = useFileDrop(id, writable);
  const me = useMemo(() => (net.self ? { peerId: net.self.peerId, name: net.self.name } : undefined), [net.self?.peerId, net.self?.name]);
  // Who's here besides you: the friend, or the channel's members (for the Claude button, @ and the pills).
  const people = useMemo(
    () => (friend ? [{ peerId: friend.peerId, name: friend.name }] : (group?.members.filter((m) => !m.self).map((m) => ({ peerId: m.peerId, name: m.name })) ?? [])),
    [friend?.peerId, friend?.name, group?.members],
  );
  const world = useMemo(() => channelWorld(me, people), [me, people]);
  // Your Claude, asked here, waits for your OK to ask someone ("Ask Alice's Claude?"), or asked
  // someone whose card is in your DM with them (not in this channel): shown here until it's over.
  const tasks = useApp((st) => st.gateway.tasks);
  const asking = useMemo(() => tasks.filter((t) => t.direction === 'sent' && t.conversation === id && t.chat !== id && !isFinal(t.state)), [tasks, id]);

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
    return <Empty icon="people" title={target?.kind === 'group' ? 'This channel isn’t here any more' : 'Not a friend any more'} detail="Its messages stay on this Mac, but you can’t write here." />;
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
  const send = (out: Outgoing): Promise<unknown> => client.api.network.post(id, { text: out.text, ...(out.files.length ? { files: [...out.files] } : {}), ...(out.ask ? { ask: out.ask === 'all' ? 'all' : [...out.ask] } : {}) });
  const resend = (m: MessageView): void => void send({ text: m.text, files: m.files ?? [] }).catch(() => undefined);
  const lastMine = [...messages].reverse().find((m) => m.mine)?.id;
  // A friend's Claude answering you can offer to do it on their Mac (RequestOffer).
  const mineIds = new Set(messages.filter((m) => m.mine).map((m) => m.id));
  const nameOf = (peerId: string): string => net.friends.find((f) => f.peerId === peerId)?.name ?? group?.members.find((m) => m.peerId === peerId)?.name ?? 'someone';
  const title = group ? channelName(net, group) : (friend?.name ?? '');

  return (
    <div ref={drop.ref} className={cx(s.conversation, drop.over && s.dropping)} {...drop.html}>
      <div ref={ref} className={s.log} onScroll={onScroll} role="log" aria-label={friend ? `Conversation with ${friend.name}` : `Channel ${title}`}>
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
          const plain = <Message m={m} continued={!newDay && continues(prev, m)} dm={target.kind === 'dm'} last={m.id === lastMine} resend={resend} nameOf={nameOf} world={world} offer={Boolean(m.claude?.request && !m.mine && mineIds.has(m.claude.for))} {...(me ? { me } : {})} />;
          return (
            <div key={m.id}>
              {newDay ? <div className={s.day}>{dayLabel(m.ts)}</div> : null}
              {m.task ? <TaskMessage id={m.task.id} plain={plain} /> : plain}
            </div>
          );
        })}
        {asking.map((t) => (
          <LogTaskCard key={t.id} task={t} inChat />
        ))}
        <LiveRow id={id} {...(me ? { me: me.peerId } : {})} />
      </div>
      {drop.over ? (
        <div className={s.dropHint} aria-hidden="true">
          <Icon name="clip" size={18} />
          Drop to send to {title}
        </div>
      ) : null}
      {group && !group.active ? (
        <div className={s.closed}>
          <div className={s.closedBox}>
            <Icon name="lock" size={13} />
            <span>You’re no longer in {group.name}. Its messages stay here, read-only.</span>
            <Button size="small" onClick={() => openNet({ kind: 'delete_group', groupId: group.id })}>
              Delete from This Mac…
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* What holds up your Claude working here: its tool approvals and questions (BLG-207). */}
          <Attention channel={id} />
          <NetComposer id={id} placeholder={friend ? `Message ${friend.name}` : `Message ${title}`} people={people} send={send} {...(me ? { me } : {})} {...(group?.admin ? { addPeople: () => openNet({ kind: 'add_people', groupId: group.id }) } : {})} />
        </>
      )}
    </div>
  );
}
