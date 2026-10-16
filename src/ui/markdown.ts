import { theme } from './theme.js';
import { type Line, type Seg, wrapText } from './text.js';

/** Inline markdown: `code` and **bold**. */
export function inline(text: string, base: Omit<Seg, 'text'> = {}): Seg[] {
  const segs: Seg[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ ...base, text: text.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith('`')) segs.push({ ...base, text: tok.slice(1, -1), color: theme.info });
    else segs.push({ ...base, text: tok.slice(2, -2), bold: true });
    last = idx + tok.length;
  }
  if (last < text.length) segs.push({ ...base, text: text.slice(last) });
  return segs.length ? segs : [{ ...base, text: '' }];
}

/**
 * Render a small, safe subset of Markdown into terminal lines: headings,
 * bullets, quotes, fenced code, inline code and bold. Wraps to `width`.
 */
export function renderMarkdown(text: string, width: number): Line[] {
  const out: Line[] = [];
  let inCode = false;
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      for (const l of wrapText(raw, width - 2)) out.push([{ text: '▎ ', color: theme.muted }, { text: l, color: theme.ok }]);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      for (const l of wrapText(heading[1] ?? '', width)) out.push(inline(l, { bold: true }));
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = (bullet[1] ?? '').length;
      wrapText(bullet[2] ?? '', width - indent - 2).forEach((l, i) =>
        out.push([{ text: ' '.repeat(indent) + (i === 0 ? '• ' : '  '), color: theme.muted }, ...inline(l)]),
      );
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      for (const l of wrapText(quote[1] ?? '', width - 2)) out.push([{ text: '│ ', color: theme.muted }, ...inline(l, { dim: true, italic: true })]);
      continue;
    }
    for (const l of wrapText(raw, width)) out.push(inline(l));
  }
  return out;
}
