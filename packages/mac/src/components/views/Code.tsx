import { type CSSProperties, useMemo, useState } from 'react';
import type { View } from '@beluga/shared/view-spec.js';
import { Icon } from '../Icon.js';
import { Tip, cx } from '../ui.js';
import { useTokens } from '../markdown/CodeLines.js';
import type { TokenLines } from '../markdown/highlight.js';
import { useCopied } from '../markdown/CodeBlock.js';
import type { ViewData } from './use-view-data.js';
import c from '../markdown/code.module.css';
import v from './views.module.css';

/**
 * Code Claude shows: its file name and language, line numbers from where it starts, the lines it
 * points at highlighted, Copy and soft wrap. Long code folds to its first lines. A file source
 * shows the file as it is now (Refresh reads it again).
 */

const FOLD_AT = 28;

export function CodeView({ view, data }: { view: View; data: ViewData }) {
  const text = (data.text ?? '').replace(/\n$/, '');
  const lang = view.language ?? langOf(view.filename ?? (data.source && 'path' in data.source ? data.source.path : ''));
  const tokens = useTokens(text, lang);
  const [wrap, setWrap] = useState(false);
  const [all, setAll] = useState(false);
  const [copied, copy] = useCopied();
  const lines = useMemo<TokenLines>(() => tokens ?? text.split('\n').map((content) => (content ? [{ content }] : [])), [tokens, text]);
  const marked = new Set(view.highlight);
  const long = lines.length > FOLD_AT + 6;
  const shown = long && !all ? lines.slice(0, FOLD_AT) : lines;
  const last = view.startLine + lines.length - 1;
  const gutter = { '--gutter': `${Math.max(2, String(last).length)}ch` } as CSSProperties;
  return (
    <div className={v.code}>
      <div className={v.codeBar}>
        {view.filename ? (
          <span className={v.codeFile}>
            <Icon name="file" size={11} />
            {view.filename}
          </span>
        ) : null}
        {lang ? <span className={v.codeLang}>{lang}</span> : null}
        <span className={v.grow} />
        <Tip label={wrap ? 'Don’t wrap long lines' : 'Wrap long lines'}>
          <button type="button" className={cx(v.codeTool, wrap && v.codeToolOn)} aria-label="Wrap long lines" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <Icon name="wrap" size={12} />
          </button>
        </Tip>
        <button type="button" className={v.codeTool} aria-label="Copy code" onClick={() => copy(text)}>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={cx(c.pre, c.numbered, wrap && c.wrap, tokens && c.colored, v.codePre)} style={gutter} data-lang={lang || undefined}>
        <code className={c.code}>
          {shown.map((line, i) => {
            const n = view.startLine + i;
            return (
              <span key={i} className={cx(c.line, marked.has(n) && v.codeMarked)}>
                <span className={c.ln} data-n={n} aria-hidden="true" />
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
          })}
        </code>
      </pre>
      {long ? (
        <button type="button" className={v.codeMore} onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}

const EXT: Readonly<Record<string, string>> = { ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', jsx: 'jsx', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', swift: 'swift', kt: 'kotlin', java: 'java', css: 'css', html: 'html', md: 'md', json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash', zsh: 'bash', sql: 'sql', toml: 'toml', c: 'c', h: 'c', cpp: 'cpp', diff: 'diff' };
const langOf = (file: string): string | undefined => EXT[file.split('.').pop()?.toLowerCase() ?? ''];
