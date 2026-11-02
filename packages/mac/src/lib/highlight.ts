/** Syntax colors load on demand (shiki is big), then stay: for code blocks, repo excerpts and PR diffs. */

export interface Token {
  readonly content: string;
  /** Inline style: the light color, and the dark one as --shiki-dark. */
  readonly style?: Record<string, string>;
}

export interface Highlighter {
  codeToHtml: (code: string, opts: { lang: string; themes: { light: string; dark: string } }) => string;
  /** Each line's tokens, both themes' colors. */
  tokens: (code: string, lang: string) => Token[][];
  langs: Set<string>;
}

let highlighter: Promise<Highlighter> | undefined;

const THEMES = { light: 'github-light', dark: 'github-dark-dimmed' };

export function loadHighlighter(): Promise<Highlighter> {
  highlighter ??= import('shiki').then(async ({ createHighlighter }) => {
    const langs = ['ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'sh', 'python', 'go', 'rust', 'css', 'html', 'md', 'yaml', 'sql', 'diff', 'swift', 'java', 'kotlin', 'c', 'cpp', 'ruby', 'toml'];
    const h = await createHighlighter({ themes: [THEMES.light, THEMES.dark], langs });
    return {
      codeToHtml: (code, opts) => h.codeToHtml(code, opts),
      tokens: (code, lang) => h.codeToTokens(code, { lang: lang as never, themes: THEMES }).tokens.map((line) => line.map((t) => ({ content: t.content, ...(t.htmlStyle ? { style: t.htmlStyle as Record<string, string> } : {}) }))),
      langs: new Set(h.getLoadedLanguages() as string[]),
    };
  });
  return highlighter;
}
