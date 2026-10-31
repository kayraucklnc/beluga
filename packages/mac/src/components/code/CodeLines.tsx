import { useEffect, useState } from 'react';
import { type Token, loadHighlighter } from '../../lib/highlight.js';
import { cx } from '../ui.js';
import s from './code.module.css';

/** One line to show: its number (and the old one, for a diff), whether it was added or removed, and whether it's marked. */
export interface CodeRow {
  readonly text: string;
  readonly n?: number;
  readonly old?: number;
  readonly kind?: 'add' | 'del' | 'ctx';
  readonly marked?: boolean;
}

/** The rows' tokens, once the highlighter is loaded (undefined until then, or for a language it doesn't know). */
function useTokens(rows: readonly CodeRow[], lang: string | undefined): Token[][] | undefined {
  const [tokens, setTokens] = useState<Token[][]>();
  const code = rows.map((r) => r.text).join('\n');
  useEffect(() => {
    setTokens(undefined);
    if (!lang) return;
    let alive = true;
    void loadHighlighter().then((h) => {
      if (alive && h.langs.has(lang)) setTokens(h.tokens(code, lang));
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return tokens;
}

/**
 * Lines of code with their numbers, in the window's code colors: marked lines stand out (what a
 * reviewer or Claude points at), a diff's added and removed lines are tinted. A click on a line's
 * number picks it (Shift-click picks a range) for `onPick`.
 */
export function CodeLines({ rows, lang, diff = false, picked, onPick }: { rows: readonly CodeRow[]; lang?: string; diff?: boolean; picked?: ReadonlySet<number>; onPick?: (n: number, range: boolean) => void }) {
  const tokens = useTokens(rows, lang);
  return (
    <div className={cx(s.lines, diff && s.diff)} role="table" aria-label="Code">
      {rows.map((r, i) => {
        const n = r.n ?? r.old;
        const isPicked = n !== undefined && picked?.has(n);
        return (
          <div key={i} role="row" className={cx(s.row, r.kind && s[r.kind], r.marked && s.marked, isPicked && s.picked)} data-line={n}>
            {diff ? <span className={s.num}>{r.old ?? ''}</span> : null}
            {onPick && r.n !== undefined ? (
              <button type="button" className={cx(s.num, s.numButton)} aria-label={`Line ${r.n}`} onClick={(e) => onPick(r.n!, e.shiftKey)}>
                {r.n}
              </button>
            ) : (
              <span className={s.num}>{r.n ?? ''}</span>
            )}
            {diff ? <span className={s.sign}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span> : null}
            <code className={s.text}>
              {tokens?.[i]
                ? tokens[i]!.map((t, j) => (
                    <span key={j} style={t.style}>
                      {t.content}
                    </span>
                  ))
                : r.text || ' '}
            </code>
          </div>
        );
      })}
    </div>
  );
}
