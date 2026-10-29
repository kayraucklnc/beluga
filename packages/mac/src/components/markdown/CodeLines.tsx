import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../ui.js';
import { type Token, type TokenLines, cachedTokens, tokenize } from './highlight.js';
import c from './code.module.css';

/** The code's colored tokens once they're ready (plain until then, and for unknown languages). */
export function useTokens(text: string, lang: string | undefined): TokenLines | undefined {
  const [tokens, setTokens] = useState<{ key: string; lines: TokenLines | undefined }>();
  const key = `${lang ?? ''}\0${text}`;
  // Colored before (the panel opened again on this file): drawn colored at once, not plain and then again.
  const cached = useMemo(() => cachedTokens(text, lang), [key]);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    void tokenize(text, lang)
      .then((lines) => alive && setTokens({ key, lines }))
      .catch(() => alive && setTokens({ key, lines: undefined }));
    return () => {
      alive = false;
    };
  }, [key]);
  return tokens?.key === key ? tokens.lines : cached;
}

/** Lines per block of long wrapped code. */
const CHUNK = 200;

function chunksOf(lines: TokenLines): (readonly (readonly Token[])[])[] {
  const out: (readonly (readonly Token[])[])[] = [];
  for (let i = 0; i < lines.length; i += CHUNK) out.push(lines.slice(i, i + CHUNK));
  return out;
}

function lineOf(line: readonly Token[], i: number, numbers: boolean) {
  return (
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
  );
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
  const fresh = useTokens(text, lang);
  // While a changed text is colored again (a log that grew), the lines it shares with the last
  // colored one keep their colors, so it doesn't flash plain.
  const last = useRef<{ lang: string | undefined; text: readonly string[]; lines: TokenLines } | undefined>(undefined);
  const tokens = useMemo(() => {
    const plain = text.split('\n');
    if (fresh) {
      last.current = { lang, text: plain, lines: fresh };
      return fresh;
    }
    const was = last.current;
    if (!was || was.lang !== lang) return undefined;
    return plain.map((content, i) => (was.text[i] === content && was.lines[i] ? was.lines[i] : content ? [{ content }] : []));
  }, [fresh, text, lang]);
  const lines = useMemo(() => {
    const out = tokens ?? plainLines(text);
    // A file's last line break doesn't make an empty last line.
    return out.length > 1 && out[out.length - 1]!.length === 0 && text.endsWith('\n') ? out.slice(0, -1) : out;
  }, [tokens, text]);
  const gutter = { '--gutter': `${Math.max(2, String(lines.length).length)}ch` } as CSSProperties;
  return (
    <pre className={cx(c.pre, wrap && c.wrap, numbers && c.numbered, tokens && c.colored, className)} style={gutter} data-lang={lang || undefined}>
      <code className={c.code}>
        {wrap && lines.length > CHUNK
          ? chunksOf(lines).map((chunk, k) => (
              // Long wrapped code in blocks the browser lays out only once they scroll near (a 6,000-line file in the panel opened slowly).
              <span key={k} className={c.chunk} data-chunk="" style={{ '--lines': chunk.length } as CSSProperties}>
                {chunk.map((line, i) => lineOf(line, k * CHUNK + i, numbers))}
              </span>
            ))
          : lines.map((line, i) => lineOf(line, i, numbers))}
      </code>
    </pre>
  );
});
