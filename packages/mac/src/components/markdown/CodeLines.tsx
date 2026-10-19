import { type CSSProperties, memo, useEffect, useMemo, useState } from 'react';
import { cx } from '../ui.js';
import { type TokenLines, tokenize } from './highlight.js';
import c from './code.module.css';

/** The code's colored tokens once they're ready (plain until then, and for unknown languages). */
export function useTokens(text: string, lang: string | undefined): TokenLines | undefined {
  const [tokens, setTokens] = useState<{ key: string; lines: TokenLines | undefined }>();
  const key = `${lang ?? ''}\0${text}`;
  useEffect(() => {
    let alive = true;
    void tokenize(text, lang)
      .then((lines) => alive && setTokens({ key, lines }))
      .catch(() => alive && setTokens({ key, lines: undefined }));
    return () => {
      alive = false;
    };
  }, [key]);
  return tokens?.key === key ? tokens.lines : undefined;
}

/** The text's lines as plain tokens. */
const plainLines = (text: string): TokenLines => text.split('\n').map((content) => (content ? [{ content }] : []));

export interface CodeLinesProps {
  readonly text: string;
  readonly lang?: string | undefined;
  /** Line numbers in a gutter that stays put when the code scrolls sideways. */
  readonly numbers?: boolean;
  /** Long lines wrap (under their own start) instead of scrolling sideways. */
  readonly wrap?: boolean;
  readonly className?: string;
}

/**
 * Code as lines: colored by shiki, with a line-number gutter, soft wrap, and selection that copies
 * just the code (the numbers are drawn, not text, so Find and copying skip them too).
 */
export const CodeLines = memo(function CodeLines({ text, lang, numbers = false, wrap = false, className }: CodeLinesProps) {
  const tokens = useTokens(text, lang);
  const lines = useMemo(() => {
    const out = tokens ?? plainLines(text);
    // A file's last line break doesn't make an empty last line.
    return out.length > 1 && out[out.length - 1]!.length === 0 && text.endsWith('\n') ? out.slice(0, -1) : out;
  }, [tokens, text]);
  const gutter = { '--gutter': `${Math.max(2, String(lines.length).length)}ch` } as CSSProperties;
  return (
    <pre className={cx(c.pre, wrap && c.wrap, numbers && c.numbered, tokens && c.colored, className)} style={gutter} data-lang={lang || undefined}>
      <code className={c.code}>
        {lines.map((line, i) => (
          <span key={i} className={c.line}>
            {numbers ? <span className={c.ln} data-n={i + 1} aria-hidden="true" /> : null}
            <span className={c.src}>
              {line.map((t, j) =>
                t.style ? (
                  <span key={j} style={t.style}>
                    {t.content}
                  </span>
                ) : (
                  t.content
                ),
              )}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
});
