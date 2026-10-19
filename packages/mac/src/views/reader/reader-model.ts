import type { ViewerState } from '@klaud/core/store.js';
import { isMarkdownPath } from '../../components/markdown/md-paths.js';

/**
 * The reader's small decisions, kept apart from its components so the panel and the Files view
 * can make them without loading the reader (it comes in its own chunk, the first time it's needed).
 */

export type ReaderMode = 'rendered' | 'source';

/** Markdown this big opens as source first (formatting it would hold the window up a moment). */
export const LARGE_MARKDOWN = 400 * 1024;

export const isMarkdownFile = (path: string): boolean => isMarkdownPath(path);

/** How a file opens at first: big Markdown as source, everything else as itself. */
export const initialMode = (viewer: Pick<ViewerState, 'path' | 'content'>): ReaderMode => (isMarkdownFile(viewer.path) && viewer.content.length > LARGE_MARKDOWN ? 'source' : 'rendered');

export const ext = (p: string): string => /\.([\w-]+)$/.exec(p)?.[1]?.toLowerCase() ?? '';

/** Extensions shiki knows by another name. */
export const LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', json: 'json', sh: 'bash', py: 'python', go: 'go', rs: 'rust', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', sql: 'sql', swift: 'swift', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', rb: 'ruby', toml: 'toml' };

/** The language a file's code is colored as (from its name). */
export const langOf = (path: string): string | undefined => {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'docker';
  if (name === 'makefile') return 'make';
  const e = ext(path);
  return LANG[e] ?? (e || undefined);
};
