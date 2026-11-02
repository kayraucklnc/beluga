import { type CSSProperties, type KeyboardEvent, useMemo, useState } from 'react';
import { cx } from '../ui.js';
import { useTokens } from './CodeLines.js';
import { canTidy, tidy } from './tidy.js';
import c from './code-editor.module.css';

export interface CodeEditorProps {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly onBlur?: () => void;
  /** shiki's name for it: sql, python, bash, json… */
  readonly lang: string | undefined;
  /** One line (a shell command): Enter doesn't break it. */
  readonly single?: boolean;
  /** Fewest lines it shows (it grows with the code, up to a cap, then scrolls). */
  readonly minRows?: number;
  readonly placeholder?: string;
  readonly invalid?: boolean;
  readonly className?: string;
  readonly 'aria-label': string;
}

/**
 * Code you can edit, in color: a transparent textarea over the same text colored by shiki, in one
 * grid cell so they wrap the same and the box grows with the code. Tab indents; a Tidy button lays
 * out SQL and JSON (what Claude wrote on one line reads as a query again).
 */
export function CodeEditor({ value, onChange, onBlur, lang, single = false, minRows = single ? 1 : 3, placeholder, invalid, className, ...rest }: CodeEditorProps) {
  const tokens = useTokens(value, lang);
  const [failed, setFailed] = useState(false);
  const tidyable = !single && canTidy(lang);
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (single && e.key === 'Enter') return e.preventDefault();
    if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = el;
    // execCommand keeps the edit on the undo stack (setting the value would drop it).
    if (!document.execCommand('insertText', false, '  ')) onChange(`${value.slice(0, a)}  ${value.slice(b)}`);
  };
  const lay = (): void => {
    void tidy(value, lang).then((out) => {
      setFailed(out === undefined);
      if (out !== undefined && out !== value) {
        onChange(out);
        onBlur?.();
      }
    });
  };
  // The colored copy: a trailing newline still needs a line under it, or the caret has nowhere to sit.
  const shown = useMemo(() => tokens ?? value.split('\n').map((content) => (content ? [{ content }] : [])), [tokens, value]);
  return (
    <div className={cx(c.editor, single && c.single, invalid && c.invalid, className)} style={{ '--rows': minRows } as CSSProperties}>
      <div className={c.stack}>
        <pre className={cx(c.layer, c.colors, tokens && c.colored)} aria-hidden="true">
          {shown.map((line, i) => (
            <span key={i}>
              {line.map((t, j) =>
                'style' in t && t.style ? (
                  <span key={j} style={t.style}>
                    {t.content}
                  </span>
                ) : (
                  t.content
                ),
              )}
              {i < shown.length - 1 ? '\n' : ' '}
            </span>
          ))}
        </pre>
        <textarea
          {...rest}
          className={cx(c.layer, c.input)}
          value={value}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => {
            setFailed(false);
            onChange(single ? e.target.value.replace(/\n/g, ' ') : e.target.value);
          }}
          onBlur={onBlur}
          onKeyDown={keyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
        />
      </div>
      {tidyable && value.trim() ? (
        <button type="button" className={c.tidy} onClick={lay} title={failed ? 'It doesn’t read as valid, so it was left as is' : 'Lay it out on lines, indented'}>
          {failed ? 'Can’t tidy' : 'Tidy'}
        </button>
      ) : null}
    </div>
  );
}
