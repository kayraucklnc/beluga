import { useEffect, useRef, useState } from 'react';
import { activityOf } from '@klaud/ui/workspace-models.js';
import { ChatLog } from '../chat/ChatLog.js';
import { Icon } from '../components/Icon.js';
import { Empty, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useKlaud } from '../lib/klaud.js';
import p from './plans.module.css';

/**
 * Talking the plan through with Claude, beside it: the plan's own conversation (its head Claude
 * plans and runs it there), and a box to say what to change. The plan updates as Claude writes.
 */
export function PlanChat({ channel, draft, onClose }: { channel: string; draft: boolean; onClose: () => void }) {
  const api = useApi();
  const { client } = useKlaud();
  const actions = useActions();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = useApp((s) => activityOf(s.log, channel).running);
  const asking = useApp((s) => s.questions.some((q) => q.channel === channel) || s.approvals.some((a) => a.channel === channel));
  const wsId = channel.startsWith('ws:') ? channel.slice(3) : undefined;

  // The box grows with what you write (up to a point).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  const send = (): void => {
    const message = text.trim();
    if (!message) return;
    setText('');
    void api.session.submit(message, { channel }).catch((err: unknown) => toast(client, err instanceof Error ? err.message : String(err), 'error'));
  };

  return (
    <aside className={p.chat} aria-label="Conversation">
      <header className={p.chatHead}>
        <span className={p.chatTitle}>
          <Icon name="claude" size={13} />
          Claude
        </span>
        {busy ? (
          <span className={p.chatBusy}>
            <span className={p.pillDot} />
            working
          </span>
        ) : null}
        <span className={p.grow} />
        {wsId ? <IconButton icon="expand" label="Open the Whole Conversation" onClick={() => actions.run({ type: 'open_ws', id: wsId, tab: 'chat' })} /> : null}
        <IconButton icon="x" label="Hide the Conversation" onClick={onClose} />
      </header>
      <div className={p.chatLog}>
        <ChatLog key={channel} channel={channel} empty={<Empty icon="flag" title="Plan it together" detail={draft ? 'Claude is reading the code and writing the plan. Tell it what to change: the plan on the left updates as it goes.' : 'Ask Claude about the plan, or tell it what to change.'} />} />
      </div>
      {asking && wsId ? (
        <button type="button" className={p.chatAsk} onClick={() => actions.run({ type: 'open_ws', id: wsId, tab: 'chat' })}>
          <Icon name="alert" size={12} />
          Claude asked you something. Answer it in the conversation
        </button>
      ) : null}
      <form
        className={p.chatBox}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={box}
          className={cx(p.chatInput, 'selectable')}
          rows={1}
          value={text}
          placeholder={draft ? 'Tell Claude what to change…' : 'Ask about the plan, or change it…'}
          aria-label="Message Claude about the plan"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Tip label="Send" keys="↩">
          <button type="submit" className={p.chatSend} aria-label="Send" disabled={!text.trim()}>
            <Icon name="send" size={13} />
          </button>
        </Tip>
      </form>
    </aside>
  );
}
