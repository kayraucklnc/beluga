/**
 * The Scratch tab, as plain data: how long ago a file was written, what kind of file it is, and
 * which one the preview shows. No DOM here, so it's tested on its own.
 */

export interface ScratchEntry {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}

export type ScratchKind = 'image' | 'pdf' | 'json' | 'markdown' | 'text';

/** A file written this recently is marked as new. */
export const FRESH_MS = 15_000;

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 2) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function fileKind(path: string): ScratchKind {
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return 'image';
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  return 'text';
}

export const isFresh = (mtime: number, now = Date.now()): boolean => now - mtime < FRESH_MS;

/** The file the preview shows: the newest while following, else the one you picked (the newest once it's gone). */
export function followed(files: readonly ScratchEntry[], follow: boolean, picked: string | undefined): string | undefined {
  if (!follow && picked && files.some((f) => f.path === picked)) return picked;
  return files[0]?.path;
}
