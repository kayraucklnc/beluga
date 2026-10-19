import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatFile } from '@klaud/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton, Tip, cx } from '../components/ui.js';
import { inApp } from '../lib/boot.js';
import { useKlaud } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { quoted } from '../chat/message-menu.js';
import { PendingTray } from './ChatFiles.js';
import { addBlobs, addPaths, restorePending, takePending, usePending } from './attachments.js';
import { type Ask, askLabel, askTo } from './chat-model.js';
import c from '../chat/composer.module.css';
import s from './network.module.css';

/** What you were writing in each conversation (kept while the app runs, like Messages). */
const drafts = new Map<string, string>();

/** Put a quote in the message box of the conversation on screen. */
export const QUOTE_EVENT = 'klaud:net-quote';
/** Ask a Claude with the next message (the menu, a message's "Ask Claude About This"). */
export const ASK_EVENT = 'klaud:net-ask';

const MAX = 8000;

export interface Outgoing {
  readonly text: string;
  readonly files: readonly ChatFile[];
  readonly ask?: 'all' | readonly string[];
}

export interface Person {
  readonly peerId: string;
  readonly name: string;
}

/** Pick files with the standard Open panel (in a browser, the page's file picker). */
async function pickFiles(client: ReturnType<typeof useKlaud>['client'], id: string, input: HTMLInputElement | null): Promise<void> {
  if (!inApp()) return void input?.click();
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: true, title: 'Send Files' });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (paths.length) await addPaths(client, id, paths);
}

/** The Claude button: nobody's (the default), yours, everyone's, or one person's, for the next message only. */
function AskButton({ ask, setAsk, people, me }: { ask: Ask | undefined; setAsk: (a: Ask | undefined) => void; people: readonly Person[]; me?: Person }) {
  const items: ActionItem[] = [
    { label: 'Ask Your Claude', icon: 'claude', checked: ask?.kind === 'me', hint: 'It answers here, from this conversation', onSelect: () => setAsk({ kind: 'me' }) },
    ...(people.length ? [{ label: people.length === 1 ? 'Ask Both Claudes' : 'Ask Everyone’s Claude', icon: 'people' as const, checked: ask?.kind === 'all', hint: 'Each answers from their own Mac', onSelect: () => setAsk({ kind: 'all' }) }] : []),
    ...people.map((p, i) => ({ label: `Ask ${p.name}’s Claude`, separate: i === 0, checked: ask?.kind === 'person' && ask.peerId === p.peerId, onSelect: () => setAsk({ kind: 'person', peerId: p.peerId, name: p.name }) })),
    ...(ask ? [{ label: 'Just Send the Message', separate: true, onSelect: () => setAsk(undefined) }] : []),
  ];
  return (
    <ActionsDropdown items={items} align="start">
      <button type="button" className={cx(c.chip, ask && c.chipOn)} aria-label={ask ? `${askLabel(ask)} (change)` : 'Ask Claude'} disabled={!me}>
        <Icon name="claude" size={13} />
        {ask ? askLabel(ask, true) : 'Ask Claude'}
        <Icon name="chevronDown" size={9} />
      </button>
    </ActionsDropdown>
  );
}

/**
 * The message box of a conversation with friends: words, files (paper clip, paste, or drop
 * anywhere on the conversation) and, only when you choose, a Claude to answer. Return sends
 * (or ⌘Return, as in Settings); a failed send puts everything back.
 */
export function NetComposer({ id, placeholder, people, me, send }: { id: string; placeholder: string; people: readonly Person[]; me?: Person; send: (out: Outgoing) => Promise<unknown> }) {
  const { client } = useKlaud();
  const prefs = usePrefs();
  const [text, setText] = useState(() => drafts.get(id) ?? '');
  const [ask, setAsk] = useState<Ask>();
  const pending = usePending(id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setText(drafts.get(id) ?? '');
    setAsk(undefined);
    ref.current?.focus();
  }, [id]);
  useEffect(() => {
    if (text) drafts.set(id, text);
    else drafts.delete(id);
  }, [id, text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 12 * 20 + 16)}px`;
  }, [text]);
  useEffect(() => {
    const quote = (e: Event): void => {
      const q = (e as CustomEvent<string>).detail;
      setText((t) => `${quoted(q)}\n\n${t.trim()}`);
      ref.current?.focus();
    };
    const asked = (e: Event): void => {
      setAsk((e as CustomEvent<Ask>).detail);
      ref.current?.focus();
    };
    const focus = (): void => ref.current?.focus();
    document.addEventListener(QUOTE_EVENT, quote);
    document.addEventListener(ASK_EVENT, asked);
    document.addEventListener('klaud:focus-composer', focus);
    return () => {
      document.removeEventListener(QUOTE_EVENT, quote);
      document.removeEventListener(ASK_EVENT, asked);
      document.removeEventListener('klaud:focus-composer', focus);
    };
  }, []);
  const over = text.length > MAX;
  const adding = pending.some((p) => p.state === 'adding');
  const ready = pending.filter((p) => p.state === 'ready');
  const canSend = !over && !adding && (Boolean(text.trim()) || ready.length > 0);
  const submit = (): void => {
    if (!canSend) return;
    const body = text.trim();
    const files = takePending(id);
    const to = ask && me ? askTo(ask, me.peerId) : undefined;
    setText('');
    setAsk(undefined);
    send({ text: body, files, ...(to ? { ask: to } : {}) }).catch(() => {
      // Nothing is lost: the words and files come back (ahead of anything new).
      setText((t) => (t.trim() ? `${body}\n${t}` : body));
      restorePending(id, files);
      client.store.dispatch({ type: 'toast', text: 'Your message wasn’t sent. It’s back in the box.', level: 'warn' });
    });
  };
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`;
  const label = ask ? `${askLabel(ask)} · ` : '';
  return (
    <div className={c.wrap}>
      <div className={cx(c.box, ask && c.asking)}>
        {ask ? (
          <span className={c.askChip}>
            <Icon name="claude" size={12} />
            {askLabel(ask)}
            <button type="button" aria-label="Don’t ask Claude" onClick={() => setAsk(undefined)}>
              <Icon name="x" size={10} />
            </button>
          </span>
        ) : null}
        <PendingTray id={id} items={pending} />
        <textarea
          ref={ref}
          className={`${c.input} selectable`}
          rows={1}
          value={text}
          placeholder={ask ? `${askLabel(ask)}…` : placeholder}
          aria-label={placeholder}
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.items].flatMap((it) => (it.kind === 'file' ? [it.getAsFile()].filter((f): f is File => Boolean(f)) : []));
            if (!files.length) return;
            e.preventDefault();
            void addBlobs(client, id, files);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Escape' && ask) {
              e.preventDefault();
              setAsk(undefined);
              return;
            }
            if (e.key !== 'Enter') return;
            const modKey = e.metaKey || e.ctrlKey;
            const sends = prefs.sendWith === 'enter' ? !e.shiftKey && !modKey : modKey;
            if (!sends) return;
            e.preventDefault();
            submit();
          }}
        />
        <div className={c.bar}>
          <IconButton icon="clip" label="Send Files…" onClick={() => void pickFiles(client, id, picker.current)} />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void addBlobs(client, id, files);
            }}
          />
          <AskButton ask={ask} setAsk={setAsk} people={people} {...(me ? { me } : {})} />
          <span className={c.flex} />
          {text.length > MAX - 500 ? <span className={cx(s.counter, over && s.counterOver)}>{MAX - text.length}</span> : null}
          <Tip label={`${label}${prefs.sendWith === 'enter' ? 'Send · Shift+Return for a new line' : `Send · ${mod()}Return`}`} keys={sendKeys}>
            <button type="button" className={cx(c.send, canSend && c.sendReady)} onClick={submit} aria-label={ask ? `Send and ${askLabel(ask).toLowerCase()}` : 'Send'} disabled={!canSend}>
              <Icon name="send" size={14} />
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
