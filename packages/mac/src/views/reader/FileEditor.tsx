import { type CSSProperties, type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../components/ui.js';
import type { DocVariant } from '../../components/markdown/MarkdownDoc.js';
import { useTokens } from '../../components/markdown/CodeLines.js';
import type { Token } from '../../components/markdown/highlight.js';
import { type EditSession, setDraft } from './edit-store.js';
import { alignTokens, indentOf } from './editor-model.js';
import c from '../../components/markdown/code.module.css';
import r from './reader.module.css';

/**
 * A file you chose to edit: a plain text box over the same colored lines the reader shows (the
 * box's own text is invisible, its caret and selection aren't). Colors catch up a moment after you
 * stop typing; until then only the lines you changed are plain.
 */

const Line = memo(function Line({ n, tokens, text }: { n: number; tokens: readonly Token[] | undefined; text: string }) {
  return (
    <span className={c.line}>
      <span className={c.ln} data-n={n} aria-hidden="true" />
      <span className={c.src}>
        {tokens
          ? tokens.map((t, j) =>
              t.style ? (
                <span key={j} style={t.style}>
                  {t.content}
                </span>
              ) : (
                t.content
              ),
            )
          : text}
      </span>
    </span>
  );
});

/** The draft, a moment behind (coloring a big file on every key would lag the typing). */
function useSettled(text: string, ms: number): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (settled === text) return;
    const t = setTimeout(() => setSettled(text), ms);
    return () => clearTimeout(t);
  }, [text]);
  return settled;
}

export function FileEditor({ session, lang, variant }: { session: EditSession; lang: string | undefined; variant: DocVariant }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const draft = session.draft;
  const settled = useSettled(draft, 140);
  const tokens = useTokens(settled, lang);
  const lines = useMemo(() => draft.split('\n'), [draft]);
  const settledLines = useMemo(() => settled.split('\n'), [settled]);
  const colored = useMemo(() => alignTokens(lines, settledLines, tokens), [lines, settledLines, tokens]);
  const indent = useMemo(() => indentOf(session.base), [session.base]);
  const gutter = { '--gutter': `${Math.max(2, String(lines.length).length)}ch` } as CSSProperties;

  // Editing starts where you are: the box takes the keyboard.
  useEffect(() => {
    area.current?.focus({ preventScroll: true });
  }, [session.key]);

  const insert = (text: string): void => {
    // Through the editing commands, so ⌘Z undoes it like typing.
    if (!document.execCommand('insertText', false, text)) {
      const el = area.current;
      if (!el) return;
      el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
      setDraft(session.key, el.value);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget;
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.shiftKey) return;
      e.preventDefault();
      insert(indent);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // A new line starts as indented as the one you were on.
      const start = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
      const lead = /^[ \t]*/.exec(el.value.slice(start, el.selectionStart))?.[0] ?? '';
      if (!lead) return;
      e.preventDefault();
      insert(`\n${lead}`);
    }
  };

  return (
    <div className={cx(r.editor, r[`e_${variant}`])} style={gutter}>
      <pre className={cx(c.pre, c.numbered, tokens && c.colored, r.editorLines)} data-lang={lang || undefined} aria-hidden="true">
        <code className={c.code}>
          {lines.map((text, i) => (
            <Line key={i} n={i + 1} tokens={colored[i]} text={text} />
          ))}
        </code>
      </pre>
      <textarea
        ref={area}
        className={r.editArea}
        value={draft}
        wrap="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-label={`Edit ${session.path}`}
        onChange={(e) => setDraft(session.key, e.target.value)}
        onKeyDown={onKey}
        // Its text lines up with the lines under it only while it never scrolls by itself.
        onScroll={(e) => {
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
      />
    </div>
  );
}
