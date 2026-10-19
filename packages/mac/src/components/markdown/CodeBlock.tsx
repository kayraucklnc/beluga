import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon.js';
import { Tip, cx } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { CodeLines } from './CodeLines.js';
import c from './code.module.css';

/** "Copied" for a moment after a copy button is pressed. */
export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string): void => {
    void copyText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    });
  };
  return [copied, copy];
}

/** A fenced code block in a document: colored, with its language, soft wrap and Copy on hover. */
export function CodeBlock({ code, lang }: { code: string; lang?: string | undefined }) {
  const [wrap, setWrap] = useState(false);
  const [copied, copy] = useCopied();
  return (
    <div className={c.block}>
      <div className={c.tools}>
        {lang ? <span className={c.lang}>{lang}</span> : null}
        <Tip label={wrap ? 'Don’t wrap long lines' : 'Wrap long lines'}>
          <button type="button" className={cx(c.tool, wrap && c.toolOn)} aria-label="Wrap long lines" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            <Icon name="wrap" size={12} />
          </button>
        </Tip>
        <button type="button" className={c.tool} aria-label="Copy code" onClick={() => copy(code)}>
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <CodeLines text={code} lang={lang} wrap={wrap} />
    </div>
  );
}
