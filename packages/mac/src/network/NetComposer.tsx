import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { useKlaud } from '../lib/klaud.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { quoted } from '../chat/message-menu.js';
import c from '../chat/composer.module.css';
import s from './network.module.css';

/** What you were writing in each conversation (kept while the app runs, like Messages). */
const drafts = new Map<string, string>();

/** Put a quote in the message box of the conversation on screen. */
export const QUOTE_EVENT = 'klaud:net-quote';

const MAX = 8000;

/**
 * The message box of a conversation with friends: the room's look, just words (no Claude
 * controls). Return sends (or ⌘Return, as in Settings); a failed send puts the text back.
 */
export function NetComposer({ id, placeholder, send }: { id: string; placeholder: string; send: (text: string) => Promise<unknown> }) {
  const { client } = useKlaud();
  const prefs = usePrefs();
  const [text, setText] = useState(() => drafts.get(id) ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText(drafts.get(id) ?? '');
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
    const focus = (): void => ref.current?.focus();
    document.addEventListener(QUOTE_EVENT, quote);
    document.addEventListener('klaud:focus-composer', focus);
    return () => {
      document.removeEventListener(QUOTE_EVENT, quote);
      document.removeEventListener('klaud:focus-composer', focus);
    };
  }, []);
  const over = text.length > MAX;
  const submit = (): void => {
    const body = text.trim();
    if (!body || over) return;
    setText('');
    send(body).catch(() => {
      // Nothing typed is lost: it comes back (ahead of anything new).
      setText((t) => (t.trim() ? `${body}\n${t}` : body));
      client.store.dispatch({ type: 'toast', text: 'Your message wasn’t sent. It’s back in the box.', level: 'warn' });
    });
  };
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`;
  return (
    <div className={c.wrap}>
      <div className={c.box}>
        <textarea
          ref={ref}
          className={`${c.input} selectable`}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key !== 'Enter') return;
            const modKey = e.metaKey || e.ctrlKey;
            const sends = prefs.sendWith === 'enter' ? !e.shiftKey && !modKey : modKey;
            if (!sends) return;
            e.preventDefault();
            submit();
          }}
        />
        <div className={c.bar}>
          <span className={c.flex} />
          {text.length > MAX - 500 ? <span className={cx(s.counter, over && s.counterOver)}>{MAX - text.length}</span> : null}
          <Tip label={prefs.sendWith === 'enter' ? 'Send · Shift+Return for a new line' : `Send · ${mod()}Return`} keys={sendKeys}>
            <button type="button" className={cx(c.send, text.trim() && !over && c.sendReady)} onClick={submit} aria-label="Send" disabled={!text.trim() || over}>
              <Icon name="send" size={14} />
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
