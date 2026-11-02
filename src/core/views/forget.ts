import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { type Source, parseView, sourceKey, viewFenceType } from '../../shared/view-spec.js';
import { forgetSource, viewDataDir } from './kept.js';
import { viewScriptsDir } from './scripts.js';

/**
 * When a conversation goes, what its views left on this Mac goes with it. Archived: the rows
 * they fetched (kept.ts) go, since running the source makes them again; what brings them stays
 * (a script Claude wrote, rows Claude handed over that were too many for the answer), so the
 * views work again when it's restored. Deleted: those go too, unless another conversation still
 * shows them.
 */

const FENCE = /^```(beluga-[a-z]+)[^\n]*\n([\s\S]*?)\n```/gm;

/** The sources a view's block names: its own, its actions', its controls' and their options'. */
export function sourcesOf(blockText: string, lang?: string): Source[] {
  const type = viewFenceType(lang);
  const parsed = parseView(blockText, type && type !== 'any' ? type : undefined);
  if (!parsed.ok) return [];
  const v = parsed.view;
  return [v.source, ...v.actions.map((a) => a.source), v.initial?.source, ...v.controls.flatMap((c) => [c.source, ...(c.options ?? []).map((o) => o.source)])].filter((s): s is Source => Boolean(s));
}

/** Every source in the views of some Markdown (an answer). */
export function sourcesIn(markdown: string): Source[] {
  const out: Source[] = [];
  for (const m of markdown.matchAll(FENCE)) if (viewFenceType(m[1]) !== undefined) out.push(...sourcesOf(m[2]!, m[1]));
  return out;
}

/** The files Beluga made for a source (a script, or rows it was handed), if it's one of those. */
function madeFiles(source: Source): string[] {
  if (source.kind === 'file') return path.dirname(source.path) === viewDataDir() ? [source.path] : [];
  if (source.kind === 'command') return [...source.command.matchAll(/'([^']+)'/g)].map((m) => m[1]!).filter((f) => path.dirname(f) === viewScriptsDir());
  return [];
}

export interface Forgotten {
  /** Sources whose kept rows went. */
  readonly rows: number;
  /** Scripts and handed-over rows deleted. */
  readonly files: number;
}

/**
 * Forget what the views in these answers left (`texts`: the conversation's). `deleted`: their
 * scripts and handed-over rows too, except those still named in `elsewhere` (other conversations).
 */
export function forgetViews(texts: readonly string[], how: 'archived' | 'deleted', elsewhere: () => readonly string[] = () => []): Forgotten {
  const sources = new Map<string, Source>();
  for (const t of texts) if (t.includes('```beluga-')) for (const s of sourcesIn(t)) sources.set(sourceKey(s), s);
  let rows = 0;
  for (const key of sources.keys()) if (forgetSource(key)) rows++;
  if (how !== 'deleted') return { rows, files: 0 };
  const files = new Set([...sources.values()].flatMap(madeFiles));
  if (!files.size) return { rows, files: 0 };
  const others = elsewhere();
  let gone = 0;
  for (const f of files) {
    if (!existsSync(f) || others.some((t) => t.includes(f))) continue;
    rmSync(f, { force: true });
    gone++;
  }
  return { rows, files: gone };
}
