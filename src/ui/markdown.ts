import { theme } from './theme.js';
import { type Line, type Seg, wrapText } from './text.js';

/** Inline markdown: `code`, **bold**, *italic*, and [links](url). */
export function inlineSegs(text: string, base: Omit<Seg, 'text'> = {}, hrefs?: ReadonlyMap<string, string>): Seg[] {
  const segs: Seg[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|⟦[^⟧]+⟧|\[[^\]]+\]\([^)]+\)|(?<![*\w])\*[^*\s][^*]*\*(?![*\w]))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ ...base, text: text.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith('`')) segs.push({ ...base, text: tok.slice(1, -1), color: theme.info });
    else if (tok.startsWith('**')) segs.push({ ...base, text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith('⟦')) {
      const href = hrefs?.get(tok.slice(1, -1));
      segs.push({ ...base, text: tok.slice(1, -1), color: theme.info, ...(href ? { link: { kind: 'href' as const, href } } : {}) });
    }
    else if (tok.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      segs.push({ ...base, text: link?.[1] ?? tok, color: theme.info, ...(link?.[2] ? { link: { kind: 'href' as const, href: link[2] } } : {}) });
    } else segs.push({ ...base, text: tok.slice(1, -1), italic: true });
    last = idx + tok.length;
  }
  if (last < text.length) segs.push({ ...base, text: text.slice(last) });
  return segs.length ? segs : [{ ...base, text: '' }];
}

/**
 * Render a safe subset of Markdown into terminal lines: headings, bullets,
 * numbered lists, quotes, rules, fenced code, inline code, bold, italic, links.
 */
export function renderMarkdown(text: string, width: number): Line[] {
  const out: Line[] = [];
  let inCode = false;
  // Link targets, by link text (kept so the chat can make them clickable).
  const hrefs = new Map<string, string>();
  const inline = (t: string, base: Omit<Seg, 'text'> = {}): Seg[] => inlineSegs(t, base, hrefs);
  for (const source of text.split('\n')) {
    // Collapse links to their text before wrapping so URLs don't eat line width.
    const raw = inCode
      ? source
      : source.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
          hrefs.set(label, href);
          return `⟦${label}⟧`;
        });
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      for (const l of wrapText(raw, width - 2)) out.push([{ text: '▎ ', color: theme.border }, { text: l, color: theme.ok }]);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const color = level === 1 ? theme.accent : level === 2 ? theme.text : theme.muted;
      for (const l of wrapText(heading[2] ?? '', width)) out.push(inline(l, { bold: true, color }));
      if (level <= 2) out.push([{ text: (level === 1 ? '━' : '─').repeat(Math.min(width, 60)), color: theme.border }]);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(raw)) {
      out.push([{ text: '─'.repeat(Math.min(width, 60)), color: theme.border }]);
      continue;
    }
    const bullet = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = (bullet[1] ?? '').length;
      const marker = bullet[2] ? `${bullet[2]}. ` : '• ';
      wrapText(bullet[3] ?? '', width - indent - marker.length).forEach((l, i) =>
        out.push([{ text: ' '.repeat(indent) + (i === 0 ? marker : ' '.repeat(marker.length)), color: theme.muted }, ...inline(l)]),
      );
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      for (const l of wrapText(quote[1] ?? '', width - 2)) out.push([{ text: '│ ', color: theme.border }, ...inline(l, { dim: true, italic: true })]);
      continue;
    }
    for (const l of wrapText(raw, width)) out.push(inline(l));
  }
  return out;
}

export const isMarkdownPath = (p: string): boolean => /\.(md|markdown|mdx)$/i.test(p);

/** Inline markdown (see inlineSegs). */
export const inline = (text: string, base: Omit<Seg, 'text'> = {}): Seg[] => inlineSegs(text, base);
