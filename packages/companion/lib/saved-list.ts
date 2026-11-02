/**
 * What the phone saved of your outputs (BLG-122), as a list: pure, so it's tested without a phone.
 * lib/saved.ts keeps it (in kv) and does the saving and deleting.
 */

export interface SavedFile {
  /** The saved file's own URI (a content:// one in the folder you picked). */
  readonly uri: string;
  readonly name: string;
  readonly kind: string;
  readonly size: number;
  /** When it was saved. */
  readonly at: number;
  /** The conversation it came from (`conv:…`): when that's archived or deleted on the Mac, it goes. */
  readonly topic?: string;
}

/** A name not taken in the folder: "shot.png", then "shot (2).png", "shot (3).png"… */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';
  if (!taken.has(clean)) return clean;
  const dot = clean.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
  for (let i = 2; ; i++) {
    const next = `${stem} (${i})${ext}`;
    if (!taken.has(next)) return next;
  }
}

/** The conversations to ask the Mac about (each once). */
export const topicsOf = (list: readonly SavedFile[]): string[] => [...new Set(list.flatMap((s) => (s.topic?.startsWith('conv:') ? [s.topic] : [])))].slice(0, 500);

/** The saved files of conversations that are gone, and those that stay. */
export function split(list: readonly SavedFile[], gone: readonly string[]): { drop: SavedFile[]; keep: SavedFile[] } {
  const g = new Set(gone);
  const drop = list.filter((s) => s.topic && g.has(s.topic));
  return { drop, keep: list.filter((s) => !drop.includes(s)) };
}

/** Saved files by conversation, the newest first, with what each group takes. */
export function groups(list: readonly SavedFile[], titleOf: (topic: string | undefined) => string): { key: string; title: string; bytes: number; files: SavedFile[] }[] {
  const by = new Map<string, SavedFile[]>();
  for (const s of [...list].sort((a, b) => b.at - a.at)) {
    const key = s.topic ?? '';
    by.set(key, [...(by.get(key) ?? []), s]);
  }
  return [...by].map(([key, files]) => ({ key, title: titleOf(key || undefined), bytes: files.reduce((n, f) => n + f.size, 0), files }));
}

export const totalBytes = (list: readonly SavedFile[]): number => list.reduce((n, s) => n + s.size, 0);
