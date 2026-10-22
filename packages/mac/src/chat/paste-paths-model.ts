/**
 * Which pasted text is file paths: "/Users/…/CleanShot … .png" quoted (straight or “smart”), with
 * escaped spaces, ~/…, or a file:// URL; one or more, one per line. And, in any other text, where
 * an image's path sits in it. (Pure: paste-paths.ts asks klaud about them.)
 */

const MAX_TEXT = 8000;
const MAX_PATHS = 20;
/** Paths in a sentence: only images become attachments there (other paths are words Claude reads). */
const IMAGE_END = /\.(?:png|jpe?g|gif|webp)/gi;
/** Ways one path inside a sentence may end, longest first, per place it starts (statting picks the real one). */
const MAX_ENDS = 4;
const MAX_CANDIDATES = MAX_PATHS;

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A path as written ("~/a", "/a/b", "file:///a/b"), or undefined if it isn't one. "/help" is a command, not a path. */
function asPath(token: string): string | undefined {
  const p = token.startsWith('file://') ? safeDecode(token.slice(7).replace(/^localhost(?=\/)/, '')) : token;
  if (/^~\/[^/\s]/.test(p)) return p;
  return /^\/[^/]+\/./.test(p) && !p.includes('\n') ? p : undefined;
}

/** Quotes around a path: straight, and the curly ones Notes, Slack or Mail put in. */
const CLOSE: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' };

/** Words of a line: '…', "…", “…” and ‘…’ are one each, and "\ " is a space inside one. */
const tokens = (line: string): string[] =>
  [...line.matchAll(/'([^']*)'|"([^"]*)"|“([^”]*)”|‘([^’]*)’|((?:\\.|[^\s\\])+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? (m[5] ?? '').replace(/\\(.)/g, '$1'));

/**
 * The paths a paste is made of, or undefined when it's anything more (or less) than paths.
 * A line is either paths (each quoted or escaped) or one path with plain spaces in it.
 */
export function pathsInPaste(text: string): string[] | undefined {
  if (text.length > MAX_TEXT) return undefined;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const out: string[] = [];
  for (const line of lines) {
    const words = tokens(line).map(asPath);
    if (words.length && words.every((w): w is string => Boolean(w))) out.push(...words);
    else if (!/["'“”‘’]/.test(line) && asPath(line.replace(/\\(.)/g, '$1'))) out.push(asPath(line.replace(/\\(.)/g, '$1'))!);
    else return undefined;
  }
  return out.length <= MAX_PATHS ? out : undefined;
}

/**
 * Where an image's path may sit in some text: `start`–`end` (quotes included) is what it replaces,
 * and `paths` are the ways to read it, longest first. A path with plain spaces in a sentence can
 * end at any ".png" along the line ("see /a/Shot 1.png and /a/b.png"): klaud says which is a file.
 */
export interface PathSpot {
  readonly start: number;
  readonly end: number;
  readonly paths: readonly { readonly path: string; readonly end: number }[];
}

/** Where a path can start in a sentence: at the line's start, after a space or an opening bracket. */
const STARTS = /(^|[\s([<{])(file:\/\/|~\/|\/(?=[^/\s]))/gm;
/** What may follow a path's end: the line going on, or punctuation closing the sentence. */
const ENDS_OK = /^(?:$|[\s.,;:!?)\]>}"'”’])/;

export function imagePathsIn(text: string): PathSpot[] {
  if (text.length > MAX_TEXT) return [];
  const spots: PathSpot[] = [];
  const taken = (at: number): boolean => spots.some((s) => at >= s.start && at < s.end);
  let candidates = 0;
  // Quoted: the quotes say where it ends.
  for (const m of text.matchAll(/["'“‘]/g)) {
    const open = m.index;
    if (taken(open)) continue;
    const close = text.indexOf(CLOSE[m[0]]!, open + 1);
    if (close < 0) continue;
    const inner = text.slice(open + 1, close);
    const path = inner.includes('\n') ? undefined : asPath(inner.replace(/\\ /g, ' '));
    if (!path || !new RegExp(`${IMAGE_END.source}$`, 'i').test(path)) continue;
    spots.push({ start: open, end: close + 1, paths: [{ path, end: close + 1 }] });
    candidates++;
  }
  // Unquoted: from where it starts to each image ending along the line. (Their readings may run
  // over each other; pickPaths keeps the ones that are files and don't.)
  const quoted = spots.length;
  for (const m of text.matchAll(STARTS)) {
    const start = m.index + m[1]!.length;
    if (spots.slice(0, quoted).some((s) => start >= s.start && start < s.end) || candidates >= MAX_CANDIDATES) continue;
    const lineEnd = text.indexOf('\n', start);
    const line = text.slice(start, lineEnd < 0 ? undefined : lineEnd);
    // A quote opens something else (a quoted path is found above).
    const stop = line.search(/["“‘]/);
    const rest = stop < 0 ? line : line.slice(0, stop);
    const ends: number[] = [];
    for (const e of rest.matchAll(IMAGE_END)) {
      const end = e.index + e[0].length;
      if (ENDS_OK.test(rest.slice(end)) && !/^\.[a-z0-9]/i.test(rest.slice(end))) ends.push(end);
    }
    const paths = ends
      .reverse()
      .slice(0, MAX_ENDS)
      .flatMap((end) => {
        const path = asPath(rest.slice(0, end).replace(/\\(.)/g, '$1'));
        return path ? [{ path, end: start + end }] : [];
      });
    if (!paths.length) continue;
    candidates += paths.length;
    spots.push({ start, end: paths[0]!.end, paths });
  }
  return spots.sort((a, b) => a.start - b.start);
}

/** Every way of reading the spots, to ask klaud about at once. */
export const candidatePaths = (spots: readonly PathSpot[]): string[] => [...new Set(spots.flatMap((s) => s.paths.map((p) => p.path)))].slice(0, MAX_PATHS);

/** The images in the text: per spot its longest reading that is an image file here, none overlapping. */
export function pickPaths(spots: readonly PathSpot[], isImage: (path: string) => boolean): { start: number; end: number; path: string }[] {
  const out: { start: number; end: number; path: string }[] = [];
  for (const spot of spots) {
    if (out.length && spot.start < out[out.length - 1]!.end) continue;
    const hit = spot.paths.find((p) => isImage(p.path));
    if (hit) out.push({ start: spot.start, end: hit.end, path: hit.path });
  }
  return out;
}
