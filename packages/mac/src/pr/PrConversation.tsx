import { useLayoutEffect, useRef, useState } from 'react';
import type { PrComment, PrReview, PrThread } from '@beluga/core/work-store.js';
import { langOf, parseHunk } from '@beluga/shared/code-ref.js';
import { Markdown } from '../chat/Markdown.js';
import { CodeLines, type CodeRow } from '../components/code/CodeLines.js';
import { Icon } from '../components/Icon.js';
import { Avatar, Button, IconButton, Tip, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import { showGitTrouble } from '../lib/git-trouble.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { agoWords } from '../issues/issues-model.js';
import { type ConversationItem, conversationCounts, timeline, usePrConversation } from './use-pr-conversation.js';
import s from './pr-conversation.module.css';

/** How many lines of the diff a thread shows above its comment. */
const HUNK_ROWS = 8;

const VERDICT: Record<PrReview['state'], { words: string; tone?: string; icon?: 'check' | 'alert' }> = {
  APPROVED: { words: 'approved these changes', tone: s.ok, icon: 'check' },
  CHANGES_REQUESTED: { words: 'requested changes', tone: s.bad, icon: 'alert' },
  COMMENTED: { words: 'reviewed' },
  DISMISSED: { words: 'reviewed (dismissed)' },
};

/** The lines a thread is on: where it was written (the hunk's numbering). */
function threadRange(t: PrThread): [number, number] | undefined {
  const end = t.originalLine ?? t.line;
  if (!end) return undefined;
  return [t.originalStartLine ?? t.startLine ?? end, end];
}

/** The last lines of a thread's diff hunk, the commented ones marked. */
export function hunkRows(t: PrThread): CodeRow[] {
  if (!t.diffHunk) return [];
  const range = threadRange(t);
  const rows = parseHunk(t.diffHunk).map((r): CodeRow => ({ text: r.text, kind: r.kind, ...(r.new !== undefined ? { n: r.new } : {}), ...(r.old !== undefined ? { old: r.old } : {}), marked: Boolean(range && r.kind !== 'del' && r.new !== undefined && r.new >= range[0] && r.new <= range[1]) }));
  const span = range ? range[1] - range[0] + 1 : 1;
  return rows.slice(-Math.max(HUNK_ROWS, span + 3));
}

const lineWords = (t: PrThread): string => {
  const range = t.line ? [t.startLine ?? t.line, t.line] : threadRange(t);
  if (!range) return '';
  return range[0] === range[1] ? `:${range[1]}` : `:${range[0]}-${range[1]}`;
};

/** A box to write in: grows with the text, sends with your send key. */
function WriteBox({ placeholder, label, busyLabel, onSend, onCancel, autoFocus }: { placeholder: string; label: string; busyLabel: string; onSend: (body: string) => Promise<boolean>; onCancel?: () => void; autoFocus?: boolean }) {
  const prefs = usePrefs();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`;
  const ready = !busy && Boolean(body.trim());
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 38), 240)}px`;
  }, [body]);
  const go = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    const ok = await onSend(body);
    setBusy(false);
    if (ok) setBody('');
  };
  return (
    <div className={cx(s.write, busy && s.busy)}>
      <textarea
        ref={box}
        className={cx(s.writeInput, 'selectable')}
        aria-label={placeholder.replace(/…$/, '')}
        placeholder={placeholder}
        value={body}
        rows={1}
        spellCheck
        autoFocus={autoFocus}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            onCancel();
            return;
          }
          if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
          const modKey = e.metaKey || e.ctrlKey;
          if (prefs.sendWith === 'enter' ? e.shiftKey || modKey : !modKey) return;
          e.preventDefault();
          void go();
        }}
      />
      <div className={s.writeBar}>
        <span className={s.writeNote}>
          <Icon name="globe" size={11} />
          On GitHub as you. Markdown works.
        </span>
        <span className={s.grow} />
        {onCancel ? (
          <Button size="small" variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Tip label={label} keys={sendKeys}>
          <Button size="small" variant="primary" icon="send" disabled={!ready} onClick={() => void go()}>
            {busy ? busyLabel : label}
          </Button>
        </Tip>
      </div>
    </div>
  );
}

/** One person's words: who, when, and what (yours are marked "you"). */
function Said({ c, what = 'commented', compact }: { c: PrComment; what?: string; compact?: boolean }) {
  const actions = useActions();
  return (
    <article className={cx(s.said, compact && s.saidCompact)}>
      <header className={s.saidHead}>
        <Avatar name={c.author} id={`gh:${c.author}`} size={compact ? 18 : 20} />
        <strong>{c.author}</strong>
        {c.mine ? <span className={s.you}>you</span> : null}
        <span className={s.when}>
          {what} {agoWords(c.at)}
        </span>
        <span className={s.grow} />
        {c.url ? (
          <button type="button" className={s.link} aria-label="Open on GitHub" title="Open on GitHub" onClick={() => actions.openLink({ kind: 'url', url: c.url })}>
            <Icon name="external" size={11} />
          </button>
        ) : null}
      </header>
      {c.body.trim() ? (
        <div className={s.body}>
          <Markdown text={c.body} />
        </div>
      ) : null}
    </article>
  );
}

/** A conversation on lines: the code it's on, what was said, and your reply, resolve, or Claude. */
function Thread({ wsId, thread, posted }: { wsId: string; thread: PrThread; posted: () => void }) {
  const api = useApi();
  const [open, setOpen] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = hunkRows(thread);
  const lang = langOf(thread.path);
  const first = thread.comments[0];
  const goTo = (): void => void api.workbench.openCode(wsId, thread.path, thread.startLine ?? thread.line ?? thread.originalLine);
  const post = async (p: Parameters<typeof api.workbench.prPost>[1]): Promise<boolean> => {
    const out = await api.workbench.prPost(wsId, p);
    if (!out) return false;
    if (!out.ok) {
      showGitTrouble(wsId, out, 'none');
      return false;
    }
    posted();
    return true;
  };
  const resolve = async (): Promise<void> => {
    setBusy(true);
    if (await post({ kind: thread.resolved ? 'unresolve' : 'resolve', thread: thread.id })) setOpen(thread.resolved);
    setBusy(false);
  };
  return (
    <section className={cx(s.thread, thread.resolved && s.resolved)} data-pr-thread={thread.id} aria-label={`Comments on ${thread.path}`}>
      <header className={s.threadHead}>
        <button type="button" className={s.fold} aria-expanded={open} aria-label={open ? 'Fold' : 'Unfold'} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        </button>
        <Tip label="Open in your editor at this line">
          <button type="button" className={s.path} onClick={goTo}>
            <Icon name="file" size={12} />
            <span>{thread.path}</span>
            <em>{lineWords(thread)}</em>
          </button>
        </Tip>
        {thread.outdated ? <span className={s.pill}>Outdated</span> : null}
        {thread.resolved ? (
          <span className={cx(s.pill, s.ok)}>
            <Icon name="check" size={10} />
            Resolved
          </span>
        ) : null}
        {!open && first ? (
          <span className={s.peek}>
            <strong>{first.author}</strong> {first.body.split('\n')[0]}
          </span>
        ) : (
          <span className={s.grow} />
        )}
        <span className={s.count}>{thread.comments.length > 1 ? `${thread.comments.length} comments` : ''}</span>
      </header>
      {open ? (
        <>
          {rows.length ? (
            <div className={s.code}>
              <CodeLines rows={rows} diff {...(lang ? { lang } : {})} />
            </div>
          ) : null}
          <div className={s.comments}>
            {thread.comments.map((c, i) => (
              <Said key={c.id} c={c} compact what={i === 0 ? 'commented' : 'replied'} />
            ))}
          </div>
          {replying ? (
            <WriteBox autoFocus placeholder="Reply…" label="Reply" busyLabel="Replying…" onCancel={() => setReplying(false)} onSend={async (body) => (await post({ kind: 'reply', thread: thread.id, body })) && (setReplying(false), true)} />
          ) : (
            <div className={s.threadActions}>
              <Button size="small" icon="chat" onClick={() => setReplying(true)}>
                Reply
              </Button>
              <Tip label="Claude reads the code there and addresses this comment in the chat">
                <Button size="small" icon="claude" onClick={() => void api.workbench.addressPrComments(wsId, thread.id)}>
                  Ask Claude
                </Button>
              </Tip>
              <span className={s.grow} />
              <Button size="small" variant="quiet" icon={thread.resolved ? 'refresh' : 'check'} disabled={busy} onClick={() => void resolve()}>
                {thread.resolved ? 'Reopen' : 'Resolve'}
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function Item({ wsId, item, posted }: { wsId: string; item: ConversationItem; posted: () => void }) {
  if (item.kind === 'thread') return <Thread wsId={wsId} thread={item.thread} posted={posted} />;
  if (item.kind === 'comment') return <Said c={item.comment} />;
  const verdict = VERDICT[item.review.state];
  return (
    <div className={s.review}>
      {verdict.icon ? (
        <span className={cx(s.verdict, verdict.tone)}>
          <Icon name={verdict.icon} size={11} />
        </span>
      ) : null}
      <Said c={item.review} what={verdict.words} />
    </div>
  );
}

/**
 * A worktree's PR conversation, under the PR strip above the chat: what everyone said on GitHub in
 * time order (comments, reviews, and threads on lines with the code they're on), and your answers.
 * Open threads first by default; resolved ones fold to a line.
 */
export function PrConversation({ wsId, onClose }: { wsId: string; onClose: () => void }) {
  const api = useApi();
  const { client } = useBeluga();
  const actions = useActions();
  const pr = useApp((st) => st.prs[wsId]);
  const { data, error, loading, refresh } = usePrConversation(wsId);
  const [all, setAll] = useState(false);
  if (!pr) return null;
  const counts = conversationCounts(data);
  const items = data ? timeline(data) : [];
  const shown = all ? items : items.filter((i) => i.kind !== 'thread' || !i.thread.resolved);
  const hidden = items.length - shown.length;
  return (
    <section className={s.panel} aria-label={`Conversation on PR #${pr.number}`} data-pr-conversation={pr.number}>
      <header className={s.head}>
        <strong>Conversation</strong>
        <span className={s.when}>
          {data ? `${counts.said} ${counts.said === 1 ? 'comment' : 'comments'}${counts.open ? ` · ${counts.open} open ${counts.open === 1 ? 'thread' : 'threads'}` : ''}` : loading ? 'Reading GitHub…' : ''}
        </span>
        <span className={s.grow} />
        {counts.open ? (
          <Tip label="Claude works through every open comment in the chat: changes the code or says why not, then commits">
            <Button size="small" variant="primary" icon="claude" onClick={() => void api.workbench.addressPrComments(wsId)}>
              Address All With Claude
            </Button>
          </Tip>
        ) : null}
        <IconButton icon="refresh" label="Read GitHub again" disabled={loading} onClick={refresh} />
        <IconButton icon="external" label="Open on GitHub" onClick={() => actions.openLink({ kind: 'url', url: pr.url })} />
        <IconButton icon="x" label="Close" onClick={onClose} />
      </header>
      <div className={s.scroll}>
        {error && !data ? (
          <div className={s.problem}>
            <Icon name="alert" size={12} />
            {error}
          </div>
        ) : null}
        {data && !items.length ? <div className={s.empty}>Nobody has said anything on #{pr.number} yet.</div> : null}
        {shown.map((item) => (
          <Item key={item.id} wsId={wsId} item={item} posted={refresh} />
        ))}
        {hidden || (all && items.some((i) => i.kind === 'thread' && i.thread.resolved)) ? (
          <button type="button" className={s.more} onClick={() => setAll(!all)}>
            {all ? 'Hide resolved threads' : `Show ${hidden} resolved ${hidden === 1 ? 'thread' : 'threads'}`}
          </button>
        ) : null}
        {data?.more ? (
          <button type="button" className={s.more} onClick={() => actions.openLink({ kind: 'url', url: pr.url })}>
            Older comments are on GitHub <Icon name="external" size={11} />
          </button>
        ) : null}
      </div>
      {data && pr.state === 'OPEN' ? (
        <footer className={s.foot}>
          <WriteBox
            placeholder={`Comment on #${pr.number}…`}
            label="Comment"
            busyLabel="Posting…"
            onSend={async (body) => {
              const out = await api.workbench.prPost(wsId, { kind: 'comment', body });
              if (!out?.ok) {
                if (out) showGitTrouble(wsId, out, 'none');
                return false;
              }
              toast(client, out.message, 'success');
              refresh();
              return true;
            }}
          />
        </footer>
      ) : null}
    </section>
  );
}
