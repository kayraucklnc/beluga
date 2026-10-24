import { useEffect } from 'react';
import { type AssistantChat, assistantChatTitle } from '@beluga/shared/assistant.js';
import { Icon } from '../components/Icon.js';
import { IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { openSheet } from '../lib/sheets.js';
import { sameDeep } from '../lib/stable.js';
import { signalOf } from '../layout/attention-model.js';
import { SignalMark } from '../layout/signal-marks.js';
import s from './assistant-tabs.module.css';

/**
 * Your Mac's chats as tabs (BLG-102, core/assistant): several conversations at once, one open.
 * + starts a new one; × deletes one for good (after asking: its messages, here and on the phone,
 * and Claude's memory of it go; there's no archive). The open tab is kept across restarts and is
 * the one your phone's Ask your Mac talks to.
 */
export function AssistantTabs() {
  const api = useApi();
  const actions = useActions();
  const { client } = useBeluga();
  const chats = useApp((st) => st.assistant.chats, sameDeep);
  const active = useApp((st) => st.assistant.active);
  const shown = useApp((st) => (st.view.kind === 'assistant' ? st.view.chat : undefined));
  // A chat this window went to (a tab, a notification) is the one open everywhere.
  useEffect(() => {
    if (shown && shown !== active && chats.some((c) => c.id === shown)) api.assistant.openChat(shown).catch(() => undefined);
  }, [shown, active, chats, api]);
  if (!chats.length) return null;
  const open = shown ?? active;
  const fail = (err: unknown): void => toast(client, err instanceof Error ? err.message : String(err), 'error');
  return (
    <div className={s.bar} role="tablist" aria-label="Your Mac’s chats">
      <div className={s.tabs}>
        {chats.map((c) => (
          <ChatTab key={c.id} chat={c} open={c.id === open} only={chats.length === 1} onOpen={() => actions.run({ type: 'view', view: { kind: 'assistant', chat: c.id } })} onDelete={(title, last) => confirmDelete(title, last, () => api.assistant.deleteChat(c.id).catch(fail))} />
        ))}
      </div>
      <IconButton icon="plus" label="New chat with Your Mac" className={s.add} onClick={() => api.assistant.newChat().catch(fail)} />
    </div>
  );
}

function ChatTab({ chat, open, only, onOpen, onDelete }: { chat: AssistantChat; open: boolean; only: boolean; onOpen: () => void; onDelete: (title: string, last: boolean) => void }) {
  const title = useApp((st) => assistantChatTitle(chat.channel, st.log));
  const said = useApp((st) => st.log.some((l) => l.channel === chat.channel));
  const signal = useApp((st) => signalOf(st, chat.channel), sameDeep);
  // The only chat, still empty: nothing to delete.
  const deletable = !only || said;
  return (
    <div className={cx(s.tab, open && s.tabOn)}>
      <Tip label={signal.tip || title}>
        <button type="button" role="tab" aria-selected={open} className={s.tabMain} onClick={onOpen}>
          <Icon name="chat" size={12} className={s.tabIcon} />
          <span className={s.tabTitle}>{title}</span>
          {open ? null : <SignalMark signal={signal} />}
        </button>
      </Tip>
      {deletable ? <IconButton icon="x" label={only ? 'Delete this chat and start over' : 'Delete this chat'} className={s.close} onClick={() => onDelete(title, only)} /> : null}
    </div>
  );
}

function confirmDelete(title: string, last: boolean, run: () => void): void {
  openSheet({
    kind: 'confirm',
    title: `Delete “${title}”?`,
    message: `Its messages go from this Mac and your phone for good, and Claude forgets the conversation. Files it made stay in Your Mac’s folder.${last ? ' A fresh chat takes its place.' : ''}`,
    confirm: 'Delete Chat',
    destructive: true,
    run,
  });
}
