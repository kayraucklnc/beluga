import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatFile } from '@beluga/net/mesh/views.js';
import { Icon } from '../components/Icon.js';
import { type ActionItem, ActionsDropdown } from '../components/SpecMenu.js';
import { IconButton, Tip, cx } from '../components/ui.js';
import { inApp } from '../lib/boot.js';
import { useBeluga } from '../lib/beluga.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { quoted } from '../chat/message-menu.js';
import { DictationStrip, MicButton } from '../chat/Dictation.js';
import { useDictationTarget } from '../lib/dictation.js';
import { MentionHighlighter } from '../chat/MentionHighlighter.js';
import { useSuggestions } from '../chat/Suggestions.js';
import { usePastePaths } from '../chat/paste-paths.js';
import { PendingTray } from './ChatFiles.js';
import { addBlobs, addPaths, restorePending, takePending, usePending } from './attachments.js';
import { type Ask, type ChannelSuggestion, askLabel, askTo, channelSuggestions, channelWorld, mentionedAsk, mergeAsk } from './chat-model.js';
import c from '../chat/composer.module.css';
import s from './network.module.css';

/** What you were writing in each conversation (kept while the app runs, like Messages). */
const drafts = new Map<string, string>();

/** Put a quote in the message box of the conversation on screen. */
export const QUOTE_EVENT = 'beluga:net-quote';
/** Ask a Claude with the next message (the menu, a message's "Ask Claude About This"). */
export const ASK_EVENT = 'beluga:net-ask';

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
async function pickFiles(client: ReturnType<typeof useBeluga>['client'], id: string, input: HTMLInputElement | null): Promise<void> {
  if (!inApp()) return void input?.click();
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: true, title: 'Send Files' });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (paths.length) await addPaths(client, id, paths);
}

/**
 * The Claude button, for the next message only. Alone with your Claude: one toggle, "Add Claude".
 * With others: the same toggle (yours), and beside it a chevron for everyone's or one person's.
 */
function AskButton({ ask, setAsk, people, me }: { ask: Ask | undefined; setAsk: (a: Ask | undefined) => void; people: readonly Person[]; me?: Person }) {
  const mine = ask?.kind === 'me';
  const toggle = (
    <Tip label={mine ? 'Your Claude answers this message · click to just send it' : 'Your Claude answers this message, from this conversation · or type @claude'}>
      <button type="button" className={cx(c.chip, people.length > 0 && s.askMain, mine && c.chipOn)} aria-pressed={mine} disabled={!me} onClick={() => setAsk(mine ? undefined : { kind: 'me' })}>
        <Icon name="claude" size={13} />
        Add Claude
      </button>
    </Tip>
  );
  if (!people.length) return toggle;
  const items: ActionItem[] = [
    { label: 'Your Claude', icon: 'claude', checked: mine, hint: 'It answers here, from your Mac', onSelect: () => setAsk({ kind: 'me' }) },
    { label: people.length === 1 ? 'Both Claudes' : 'Everyone’s Claude', icon: 'people', checked: ask?.kind === 'all', hint: 'Each answers from their own Mac', onSelect: () => setAsk({ kind: 'all' }) },
    ...people.map((p, i) => ({ label: `${p.name}’s Claude`, separate: i === 0, checked: ask?.kind === 'person' && ask.peerId === p.peerId, hint: `From ${p.name}’s Mac`, onSelect: () => setAsk({ kind: 'person', peerId: p.peerId, name: p.name }) })),
    ...(ask ? [{ label: 'Don’t Add a Claude', separate: true, onSelect: () => setAsk(undefined) }] : []),
  ];
  return (
    <span className={s.askSplit} role="group" aria-label="Add Claude">
      {toggle}
      <ActionsDropdown items={items} align="start">
        <button type="button" className={cx(c.chip, s.askMore, ask && !mine && c.chipOn)} aria-label="Add Someone Else’s Claude" disabled={!me}>
          <Icon name="chevronDown" size={9} />
        </button>
      </ActionsDropdown>
    </span>
  );
}

/**
 * The message box of a conversation with friends: words, files (paper clip, paste, or drop
 * anywhere on the conversation) and, only when you choose, a Claude to answer. Return sends
 * (or ⌘Return, as in Settings); a failed send puts everything back.
 */
export function NetComposer({ id, placeholder, people, me, send, addPeople }: { id: string; placeholder: string; people: readonly Person[]; me?: Person; send: (out: Outgoing) => Promise<unknown>; addPeople?: () => void }) {
  const { client } = useBeluga();
  const prefs = usePrefs();
  const [text, setText] = useState(() => drafts.get(id) ?? '');
  const [ask, setAsk] = useState<Ask>();
  const pending = usePending(id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // @ and / as you type: the Claudes and people here, and the channel's commands.
  const items = useMemo(() => (text ? channelSuggestions(text, { people, admin: Boolean(addPeople) }) : []), [text, people, addPeople]);
  const world = useMemo(() => channelWorld(me, people), [me, people]);
  const write = (next: string): void => {
    setText(next);
    sug.reset();
  };
  const run = (picked: ChannelSuggestion): void => {
    if (!picked.command) return write(picked.value);
    write('');
    if (picked.command === 'claude') setAsk({ kind: 'me' });
    else if (picked.command === 'claudes') setAsk({ kind: 'all' });
    else if (picked.command === 'files') void pickFiles(client, id, picker.current);
    else addPeople?.();
  };
  const sug = useSuggestions(items, text, run);
  // A pasted path of a file on this Mac: the file goes, as if dropped.
  const pastePaths = usePastePaths(ref, (files) => void addPaths(client, id, files.map((f) => f.path)));
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
    document.addEventListener('beluga:focus-composer', focus);
    return () => {
      document.removeEventListener(QUOTE_EVENT, quote);
      document.removeEventListener(ASK_EVENT, asked);
      document.removeEventListener('beluga:focus-composer', focus);
    };
  }, []);
  const over = text.length > MAX;
  const adding = pending.some((p) => p.state === 'adding');
  const ready = pending.filter((p) => p.state === 'ready');
  // Asking a Claude needs no words: it reads the conversation and answers what's open.
  const canSend = !over && !adding && (Boolean(text.trim()) || ready.length > 0 || Boolean(ask && me));
  const submit = (): void => {
    if (!canSend) return;
    const body = text.trim();
    const files = takePending(id);
    // The button and the words' mentions ("@claude", "@claude:mia", "@claudes") together; the words stay as typed.
    const to = me ? mergeAsk(ask ? askTo(ask, me.peerId) : undefined, mentionedAsk(body, me.peerId, people)) : undefined;
    setText('');
    setAsk(undefined);
    send({ text: body, files, ...(to ? { ask: to } : {}) }).catch(() => {
      // Nothing is lost: the words and files come back (ahead of anything new).
      setText((t) => (t.trim() ? `${body}\n${t}` : body));
      restorePending(id, files);
      client.store.dispatch({ type: 'toast', text: 'Your message wasn’t sent. It’s back in the box.', level: 'warn' });
    });
  };
  // Speaking instead of typing (Settings › Voice): the words come here when this is the box you're in.
  useDictationTarget(ref, submit);
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`;
  const label = ask ? `${askLabel(ask)} · ` : '';
  return (
    <div className={c.wrap}>
      {sug.list}
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
        <DictationStrip box={ref} />
        <div className={c.inputWrap}>
          <MentionHighlighter text={text} world={world} input={ref} className={c.input ?? ''} />
          <textarea
            ref={ref}
            className={`${c.input} ${c.overHighlight} selectable`}
            rows={1}
            value={text}
            placeholder={ask ? `${askLabel(ask)}: write a question, or just send and it reads the conversation` : placeholder}
            aria-label={placeholder}
            spellCheck
            onChange={(e) => write(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items].flatMap((it) => (it.kind === 'file' ? [it.getAsFile()].filter((f): f is File => Boolean(f)) : []));
              if (!files.length) return void pastePaths(e);
              e.preventDefault();
              void addBlobs(client, id, files);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (sug.onKeyDown(e)) return;
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
        </div>
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
          <MicButton box={ref} />
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
