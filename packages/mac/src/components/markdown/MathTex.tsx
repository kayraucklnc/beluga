import { useEffect, useState } from 'react';
import m from './markdown.module.css';

/**
 * `$…$` and `$$…$$`, typeset by KaTeX. It loads (with its stylesheet and fonts) the first time a
 * document has math. TeX can't run code here: `trust` is off, so no links, classes or styles from it.
 */

type Katex = (typeof import('katex'))['default'];

let katex: Promise<Katex> | undefined;

function loadKatex(): Promise<Katex> {
  katex ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => mod.default);
  return katex;
}

const cache = new Map<string, string>();

export function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const [html, setHtml] = useState(() => cache.get(key));
  useEffect(() => {
    const hit = cache.get(key);
    if (hit) return setHtml(hit);
    let alive = true;
    void loadKatex().then((k) => {
      const out = k.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
      if (cache.size > 500) cache.clear();
      cache.set(key, out);
      if (alive) setHtml(out);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  const Tag = display ? 'div' : 'span';
  if (!html) return <Tag className={display ? m.mathBlock : m.mathInline}>{tex}</Tag>;
  // KaTeX's own markup (generated from the TeX, never the document's HTML).
  return <Tag className={display ? m.mathBlock : m.mathInline} data-math={display ? 'display' : 'inline'} dangerouslySetInnerHTML={{ __html: html }} />;
}
