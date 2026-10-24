import type { ViewerState } from '../../../../../src/core/store.js';
import { isImageFile, isMarkdownPath, isVideoFile } from '../../components/markdown/md-paths.js';

/**
 * The reader's small decisions, kept apart from its components so the panel and the Files view
 * can make them without loading the reader (it comes in its own chunk, the first time it's needed).
 */

export type ReaderMode = 'rendered' | 'source';

/** Markdown this big opens as source first (formatting it would hold the window up a moment). */
export const LARGE_MARKDOWN = 400 * 1024;

export const isMarkdownFile = (path: string): boolean => isMarkdownPath(path);

export const isPdfFile = (path: string): boolean => /\.pdf$/i.test(path);

/** Shown as itself (a picture, pages, a video), never as text. */
export const isVisualFile = (path: string): boolean => isImageFile(path) || isPdfFile(path) || isVideoFile(path);

/** JSON laid out with two-space indents (a one-line API response becomes readable); undefined when it isn't JSON. */
export function prettyJson(path: string, content: string): string | undefined {
  if (!/\.json$/i.test(path) || content.length > 2_000_000) return undefined;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return undefined;
  }
}

/** What Beluga reads for a file that isn't text (a null byte in it). */
export const BINARY_TEXT = '[binary file]';

/** The file has text to copy, find in and show as source. */
export const hasText = (viewer: Pick<ViewerState, 'path' | 'image' | 'error' | 'content'>): boolean =>
  !viewer.image && !viewer.error && !isVisualFile(viewer.path) && viewer.content !== BINARY_TEXT;

/** How a file opens at first: big Markdown as source, everything else as itself. */
export const initialMode = (viewer: Pick<ViewerState, 'path' | 'content'>): ReaderMode => (isMarkdownFile(viewer.path) && viewer.content.length > LARGE_MARKDOWN ? 'source' : 'rendered');

export const ext = (p: string): string => /\.([\w-]+)$/.exec(p)?.[1]?.toLowerCase() ?? '';

/** Extensions shiki knows by another name. */
export const LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  mts: 'ts',
  cts: 'ts',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  go: 'go',
  rs: 'rust',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  mdx: 'mdx',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  swift: 'swift',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  toml: 'toml',
  xml: 'xml',
  graphql: 'graphql',
  lua: 'lua',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  tf: 'hcl',
};

/** The language a file's code is colored as (from its name). */
export const langOf = (path: string): string | undefined => {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'docker';
  if (name === 'makefile') return 'make';
  const e = ext(path);
  return LANG[e] ?? (e || undefined);
};
