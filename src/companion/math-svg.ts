import { createRequire } from 'node:module';
import { splitInlineMath } from '../shared/render/math.js';
import type { ProseView } from './protocol.js';

/**
 * Math for the phone (BLG-87): the Mac typesets it with MathJax into SVG (paths only, drawn in the
 * text's color), and the phone draws the SVG as it is: no TeX engine, no web view, no fonts there.
 * MathJax loads the first time there's math, and what it made is kept.
 */

type Typeset = (tex: string, display: boolean) => string;
let typeset: Typeset | null | undefined;

function load(): Typeset | null {
  if (typeset !== undefined) return typeset;
  try {
    const require = createRequire(import.meta.url);
    const { mathjax } = require('mathjax-full/js/mathjax.js');
    const { TeX } = require('mathjax-full/js/input/tex.js');
    const { SVG } = require('mathjax-full/js/output/svg.js');
    const { liteAdaptor } = require('mathjax-full/js/adaptors/liteAdaptor.js');
    const { RegisterHTMLHandler } = require('mathjax-full/js/handlers/html.js');
    const { AllPackages } = require('mathjax-full/js/input/tex/AllPackages.js');
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    // No `require`, `html` or `bbox`-style packages that reach outside the formula.
    const packages = (AllPackages as string[]).filter((p) => !/^(require|autoload|html|setoptions|configmacros)$/.test(p));
    const doc = mathjax.document('', { InputJax: new TeX({ packages }), OutputJax: new SVG({ fontCache: 'none' }) });
    typeset = (tex, display) => adaptor.innerHTML(doc.convert(tex, { display }));
  } catch {
    typeset = null;
  }
  return typeset;
}

export type MathSvg = NonNullable<ProseView['math']>[string];

const cache = new Map<string, MathSvg | null>();
const MAX_TEX = 4000;

/** One formula as SVG, or null when it has a mistake (the phone shows its TeX then). */
export function texToSvg(tex: string, display: boolean): MathSvg | null {
  const key = `${display ? 'D' : 'I'}${tex}`;
  if (cache.has(key)) return cache.get(key)!;
  const run = tex.length <= MAX_TEX ? load() : null;
  let out: MathSvg | null = null;
  if (run) {
    try {
      const svg = run(tex, display);
      const ex = (name: string): number => Number(new RegExp(`${name}="(-?[\\d.]+)ex"`).exec(svg)?.[1] ?? NaN);
      const v = Number(/vertical-align:\s*(-?[\d.]+)ex/.exec(svg)?.[1] ?? 0);
      const w = ex('width');
      const h = ex('height');
      if (!svg.includes('data-mml-node="merror"') && Number.isFinite(w) && Number.isFinite(h)) out = { svg: svg.replace(/ style="[^"]*"/, ''), w, h, v };
    } catch {
      out = null;
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(key, out);
  return out;
}

/** All the SVG a prose view may carry (big formulas are many paths). */
const BUDGET = 400_000;

/** The prose with its math typeset: inline `$…$` in its words, and its `math` blocks. */
export function withMath(prose: ProseView): ProseView {
  const wanted: [string, boolean][] = [];
  for (const c of prose.code) if (c.block?.kind === 'math') wanted.push([c.block.text, true]);
  if (prose.text.includes('$')) {
    for (const line of prose.text.split('\n')) {
      if (!line.includes('$')) continue;
      for (const p of splitInlineMath(line)) if ('tex' in p) wanted.push([p.tex, false]);
    }
  }
  if (!wanted.length) return prose;
  const math: Record<string, MathSvg> = {};
  let used = 0;
  for (const [tex, display] of wanted.slice(0, 200)) {
    const key = `${display ? 'D' : 'I'}${tex}`;
    if (math[key]) continue;
    const svg = texToSvg(tex, display);
    if (!svg || used + svg.svg.length > BUDGET) continue;
    used += svg.svg.length;
    math[key] = svg;
  }
  return Object.keys(math).length ? { ...prose, math } : prose;
}
