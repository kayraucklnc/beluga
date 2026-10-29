import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Tip, cx } from '../components/ui.js';
import { usePrefs } from '../lib/prefs.js';
import { mod } from '../lib/system.js';
import { useIssueActions } from './use-issues.js';
import h from '../views/project-home.module.css';
import d from '../chat/draft.module.css';
import s from './issues.module.css';

/**
 * A comment from you, under the issue's thread: Markdown, sent with your send key, posted on
 * GitHub as you. Once it's there the thread asks GitHub again (`posted`); if GitHub says no, what
 * you wrote stays in the box.
 */
export function IssueReply({ projectId, number, posted }: { projectId: string; number: number; posted: () => void }) {
  const a = useIssueActions();
  const prefs = usePrefs();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const ready = !busy && Boolean(body.trim());
  const sendKeys = prefs.sendWith === 'enter' ? '↩' : `${mod()}↩`;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 12 * 20 + 20)}px`;
  }, [body]);

  const go = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    const url = await a.comment(projectId, number, body);
    setBusy(false);
    if (!url) return;
    setBody('');
    posted();
  };

  return (
    <section className={s.reply} aria-label={`Comment on #${number}`}>
      <div className={cx(h.box, busy && h.busy)}>
        <textarea
          ref={box}
          className={cx(h.input, s.composerInput, 'selectable')}
          aria-label="Your comment"
          placeholder={`Comment on #${number}…`}
          value={body}
          rows={2}
          spellCheck
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
            const modKey = e.metaKey || e.ctrlKey;
            if (prefs.sendWith === 'enter' ? e.shiftKey || modKey : !modKey) return;
            e.preventDefault();
            void go();
          }}
        />
        <div className={h.bar}>
          <span className={h.note}>
            <Icon name="globe" size={12} />
            On GitHub as you, for everyone who can see the issue. Markdown works.
          </span>
          <span className={h.flex} />
          <Tip label={`Post your comment on #${number}`} keys={sendKeys}>
            <button type="button" className={cx(d.create, ready && d.createReady)} aria-disabled={!ready} onClick={() => void go()} data-testid="issue-comment">
              <Icon name="send" size={12} />
              {busy ? 'Posting…' : 'Comment'}
              <span className={d.createKey}>{sendKeys}</span>
            </button>
          </Tip>
        </div>
      </div>
    </section>
  );
}
