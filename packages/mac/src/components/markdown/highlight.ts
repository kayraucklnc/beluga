import type { CSSProperties } from 'react';

/**
 * Syntax colors for the reader, on demand: shiki loads the first time a file or a code block
 * needs it, and each language's grammar the first time it shows up. Every token carries both the
 * light and the dark color (`--shiki-dark`), so switching the app's look needs no new work.
 */

export interface Token {
  readonly content: string;
  readonly style?: CSSProperties;
}

export type TokenLines = readonly (readonly Token[])[];

const THEMES = { light: 'github-light', dark: 'github-dark-dimmed' } as const;

/** Past this, a file is shown in plain text (coloring it would hold the window up). */
export const HIGHLIGHT_MAX_CHARS = 200_000;
export const HIGHLIGHT_MAX_LINES = 6_000;

/** File extensions shiki doesn't know by that name. */
const ALIASES: Readonly<Record<string, string>> = {
  mjs: 'js',
  cjs: 'js',
  mts: 'ts',
  cts: 'ts',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  kt: 'kotlin',
  rs: 'rust',
  rb: 'ruby',
  py: 'python',
  node: 'js',
  postgres: 'sql',
  sqlite: 'sql',
  md: 'markdown',
  mdx: 'mdx',
  htm: 'html',
  svg: 'xml',
  plist: 'xml',
  txt: 'text',
  text: 'text',
  plain: 'text',
  conf: 'ini',
  env: 'dotenv',
  dockerfile: 'docker',
  gitignore: 'text',
};

interface Engine {
  readonly tokenize: (code: string, lang: string) => TokenLines;
  readonly load: (lang: string) => Promise<boolean>;
}

let engine: Promise<Engine> | undefined;

function loadEngine(): Promise<Engine> {
  engine ??= import('shiki').then(async ({ createHighlighter, bundledLanguages }) => {
    const h = await createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [] });
    const loading = new Map<string, Promise<boolean>>();
    const load = (lang: string): Promise<boolean> => {
      if (!(lang in bundledLanguages)) return Promise.resolve(false);
      let p = loading.get(lang);
      if (!p) {
        p = h.loadLanguage(lang as keyof typeof bundledLanguages).then(
          () => true,
          () => false,
        );
        loading.set(lang, p);
      }
      return p;
    };
    const tokenize = (code: string, lang: string): TokenLines =>
      h.codeToTokens(code, { lang: lang as keyof typeof bundledLanguages, themes: THEMES }).tokens.map((line) => line.map((t) => (t.htmlStyle ? { content: t.content, style: styleOf(t.htmlStyle) } : { content: t.content })));
    return { tokenize, load };
  });
  return engine;
}

/** shiki's inline style (`font-style`, `--shiki-dark`) as React wants it. */
function styleOf(css: Record<string, string>): CSSProperties {
  return Object.fromEntries(Object.entries(css).map(([k, v]) => [k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()), v])) as CSSProperties;
}

/** The language shiki knows a fence or an extension as ('' for plain text). */
export function languageOf(lang: string | undefined): string {
  const l = (lang ?? '').trim().toLowerCase();
  return ALIASES[l] ?? l;
}

/** Colored once per code and language, then remembered (a live file re-renders often). */
const cache = new Map<string, TokenLines>();
const CACHE_MAX = 120;

/** The code's tokens if they're already colored (so it's drawn colored at once, not plain first). */
export function cachedTokens(code: string, lang: string | undefined): TokenLines | undefined {
  const id = languageOf(lang);
  return id ? cache.get(`${id}\0${code}`) : undefined;
}

/** The code's tokens, or undefined when it stays plain (no language, too big, unknown). */
export async function tokenize(code: string, lang: string | undefined): Promise<TokenLines | undefined> {
  const id = languageOf(lang);
  if (!id || id === 'text' || code.length > HIGHLIGHT_MAX_CHARS || code.split('\n').length > HIGHLIGHT_MAX_LINES) return undefined;
  const key = `${id}\0${code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const e = await loadEngine();
  if (!(await e.load(id))) return undefined;
  const lines = e.tokenize(code, id);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, lines);
  return lines;
}
