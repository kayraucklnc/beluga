/**
 * Math in Claude's words: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` on lines of their own, and
 * ```math blocks. Prices stay prices: a `$` is math only by pandoc's rule (the opening one has a
 * character right after it, the closing one a character right before it and no digit after), so
 * "$5 and $10" is words. Pure: the Mac (remark-math) and the phone read math the same way.
 */

export type MathPiece = { readonly text: string } | { readonly tex: string };

/** Where an inline code span was held out while the prose around it is read (private-use characters). */
const HOLE = '';
const HOLE_END = '';

const isSpace =(c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/**
 * Where the inline code span opening at `i` (a backtick) ends, past its closing run, or -1 when the
 * backticks are words. As CommonMark reads it: a run of n backticks closes only on a run of exactly
 * n, so "` ```diff `" is one span.
 */
function codeSpanEnd(s: string, i: number): number {
  let n = 0;
  while (s[i + n] === '`') n++;
  for (let j = i + n; j < s.length; ) {
    if (s[j] !== '`') {
      // A span ends with its paragraph.
      if (s[j] === '\n' && /^\n[ \t]*(\n|$)/.test(s.slice(j, j + 80))) return -1;
      j++;
      continue;
    }
    let m = 0;
    while (s[j + m] === '`') m++;
    if (m === n) return j + m;
    j += m;
  }
  return -1;
}

/** Where the inline math that starts at `i` (a lone `$`) ends, or -1 when it's just a dollar. */
function closing(s: string, i: number): number {
  if (isSpace(s[i + 1]) || s[i + 1] === '$') return -1;
  for (let j = i + 2; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '`' || c === HOLE) return -1;
    if (c !== '$') continue;
    if (s[j + 1] === '$') return -1;
    if (isSpace(s[j - 1]) || isDigit(s[j + 1])) return -1;
    return j;
  }
  return -1;
}

/** A line's words and inline math, apart (inline code is left as words). */
export function splitInlineMath(line: string): MathPiece[] {
  const out: MathPiece[] = [];
  let text = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && line[i + 1] === '$') {
      text += '\\$';
      i++;
      continue;
    }
    if (c === '`') {
      const end = codeSpanEnd(line, i);
      let run = 1;
      while (line[i + run] === '`') run++;
      text += line.slice(i, end > 0 ? end : i + run);
      i = (end > 0 ? end : i + run) - 1;
      continue;
    }
    if (c === '$' && line[i + 1] !== '$' && line[i - 1] !== '$') {
      const end = closing(line, i);
      if (end > 0) {
        if (text) out.push({ text });
        text = '';
        out.push({ tex: line.slice(i + 1, end) });
        i = end;
        continue;
      }
    }
    text += c;
  }
  if (text) out.push({ text });
  return out;
}

/** Whether a line has inline math in it. */
export const hasInlineMath = (line: string): boolean => line.includes('$') && splitInlineMath(line).some((p) => 'tex' in p);

/** `\(…\)` → `$…$` and `\[…\]` → `$$…$$` (Claude writes both), outside code. */
function delimiters(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => `$$${tex}$$`)
    .replace(/\\\(([^\n]+?)\\\)/g, (_m, tex: string) => `$${tex.trim()}$`);
}

/** Each run of prose (not fenced code, not inline code) through `f`. */
function outsideCode(markdown: string, f: (prose: string) => string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  let prose: string[] = [];
  const flush = (): void => {
    if (!prose.length) return;
    // Inline code spans stay as written: each is held out as a placeholder, so `f` still sees
    // whole lines (a line that starts with `$$` really starts with it).
    const joined = prose.join('\n');
    const spans: string[] = [];
    let masked = '';
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] !== '`') {
        masked += joined[i];
        continue;
      }
      const end = codeSpanEnd(joined, i);
      if (end < 0) {
        while (joined[i + 1] === '`') masked += joined[i++];
        masked += joined[i];
        continue;
      }
      masked += `${HOLE}${spans.length}${HOLE_END}`;
      spans.push(joined.slice(i, end));
      i = end - 1;
    }
    out.push(f(masked).replace(new RegExp(`${HOLE}(\\d+)${HOLE_END}`, 'g'), (_m, n: string) => spans[Number(n)]!));
    prose = [];
  };
  for (const line of lines) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && !line.slice(open[0].length).trim()) fence = undefined;
      continue;
    }
    if (open) {
      flush();
      fence = open[1]!;
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Markdown made ready for remark-math: `\(…\)` and `\[…\]` as dollars, `$$…$$` alone on a line as
 * a block, and every `$` that isn't math escaped (so "$5 and $10" stays words).
 */
export function prepareMath(markdown: string): string {
  if (!markdown.includes('$') && !markdown.includes('\\(') && !markdown.includes('\\[')) return markdown;
  return outsideCode(markdown, (prose) =>
    delimiters(prose)
      .split('\n')
      .map((line) => {
        const block = /^(\s*)\$\$(.+?)\$\$\s*$/.exec(line);
        if (block) return `${block[1]}$$\n${block[1]}${block[2]!.trim()}\n${block[1]}$$`;
        if (/^\s*\$\$/.test(line) || /\$\$\s*$/.test(line)) return line;
        if (!line.includes('$')) return line;
        return splitInlineMath(line)
          .map((p) => ('tex' in p ? `$${p.tex}$` : p.text.replace(/(^|[^\\])\$/g, '$1\\$').replace(/(^|[^\\])\$/g, '$1\\$')))
          .join('');
      })
      .join('\n'),
  );
}

/** The phone's words: `\(…\)` and `\[…\]` as dollars (outside code), so one reading finds them. */
export const normalizeMathDelimiters = (markdown: string): string => (markdown.includes('\\(') || markdown.includes('\\[') ? outsideCode(markdown, delimiters) : markdown);

/**
 * A display block starting at line `i` (`$$` opening a line): its TeX and the line it ends on, or
 * undefined when it's not one (an unclosed `$$` stays words).
 */
export function displayMathAt(lines: readonly string[], i: number): { tex: string; end: number } | undefined {
  const first = lines[i]!.trim();
  if (!first.startsWith('$$')) return undefined;
  const one = /^\$\$(.+?)\$\$$/.exec(first);
  if (one) return { tex: one[1]!.trim(), end: i };
  const body: string[] = [first.slice(2)];
  for (let j = i + 1; j < lines.length && j < i + 200; j++) {
    const l = lines[j]!.trim();
    if (l.endsWith('$$')) {
      body.push(l.slice(0, -2));
      const tex = body.join('\n').trim();
      return tex ? { tex, end: j } : undefined;
    }
    if (!l) return undefined;
    body.push(l);
  }
  return undefined;
}

/** A ```math fence is display math; a ```latex or ```tex one too when it's a formula, not a document. */
export function isMathFence(lang: string, body: string): boolean {
  const l = lang.toLowerCase();
  if (l === 'math' || l === 'katex') return true;
  if (l !== 'latex' && l !== 'tex') return false;
  return body.split('\n').length <= 24 && !/\\(documentclass|usepackage|begin\{document\}|section|chapter|newcommand|input|include)\b/.test(body);
}
