import chalk, { Chalk } from 'chalk';
import { Marked, type MarkedExtension } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { theme } from './theme.js';

const BLOCK_START = /^\s*([#>|]|[-*+]\s|\d+[.)]\s|```|~~~|<|\s{4}|---|\*\*\*|___|$)/;

/**
 * Markdown treats single newlines inside a paragraph as spaces. Join them up front
 * so the terminal renderer can reflow paragraphs cleanly to the panel width.
 */
export function unwrapParagraphs(md: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const prev = out[out.length - 1];
    const joinable = !fence && prev !== undefined && prev.trim() !== '' && !BLOCK_START.test(line) && !/^\s*(```|~~~|\||#)/.test(prev) && !/ {2}$/.test(prev);
    if (joinable) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}

/** Drop HTML comments and tags (GitHub README markup) but keep image alt text and link text. */
export function stripHtml(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*?alt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `[image: ${alt}]` : '[image]'))
    .replace(/<img\b[^>]*>/gi, '[image]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|span|picture|source|a|b|strong|em|i|sub|sup|details|summary|center|h[1-6])\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

let cache: { key: string; lines: string[] } | undefined;

/**
 * Render Markdown to ANSI-styled lines with marked + marked-terminal: reflowed
 * paragraphs, tables, syntax-highlighted code, lists, quotes and links, all in the
 * active theme's colors.
 */
export function renderMarkdownAnsi(md: string, width: number): string[] {
  const key = `${width}|${theme.accent}|${theme.text}|${md}`;
  if (cache?.key === key) return cache.lines;
  const c = new Chalk({ level: chalk.level || 3 });
  const marked = new Marked(
    markedTerminal({
      width: Math.max(20, width),
      reflowText: true,
      showSectionPrefix: false,
      tab: 2,
      emoji: true,
      firstHeading: c.hex(theme.accent).bold,
      heading: c.hex(theme.text).bold,
      strong: c.bold,
      em: c.italic,
      del: c.dim.strikethrough,
      codespan: c.hex(theme.info),
      code: c.hex(theme.ok),
      blockquote: c.hex(theme.muted).italic,
      link: c.hex(theme.info),
      href: c.hex(theme.muted).underline,
      hr: c.hex(theme.border),
      listitem: c.reset,
      paragraph: c.reset,
      table: c.reset,
      html: c.hex(theme.muted),
      text: (s: string) => s,
      tableOptions: { style: { head: [], border: [] }, chars: { mid: '', 'left-mid': '', 'mid-mid': '', 'right-mid': '' } },
    }) as unknown as MarkedExtension, // @types/marked-terminal lags behind marked's extension type
  );
  // marked-terminal prints tight list items without parsing their inline markup (`code`, **bold**).
  marked.use({
    renderer: {
      text(token) {
        return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : token.text;
      },
    },
  });
  // Unlabeled code blocks are shown as plain text instead of guessed (often wrong) highlighting.
  const source = unwrapParagraphs(stripHtml(md)).replace(/^(\s*)```\s*$/gm, (m, indent: string, offset: number, all: string) =>
    (all.slice(0, offset).match(/^\s*```/gm)?.length ?? 0) % 2 === 0 ? `${indent}\`\`\`text` : m,
  );
  const rendered = String(marked.parse(source)).replace(/\n+$/, '');
  // marked-terminal uses "*" for bullets; a dot reads better.
  const lines = rendered.split('\n').map((l) => l.replace(/^((?:\x1b\[[0-9;]*m)*\s*)\* /, '$1• '));
  cache = { key, lines };
  return lines;
}
