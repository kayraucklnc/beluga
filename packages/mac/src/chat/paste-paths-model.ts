/**
 * Which pasted text is file paths: "/Users/…/CleanShot … .png" quoted, with escaped spaces,
 * ~/…, or a file:// URL; one or more, one per line. (Pure: paste-paths.ts asks klaud about them.)
 */

const MAX_TEXT = 8000;
const MAX_PATHS = 20;

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

/** Words of a line: '…' and "…" are one each, and "\ " is a space inside one. */
const tokens = (line: string): string[] => [...line.matchAll(/'([^']*)'|"([^"]*)"|((?:\\.|[^\s\\])+)/g)].map((m) => m[1] ?? m[2] ?? (m[3] ?? '').replace(/\\(.)/g, '$1'));

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
    else if (!/["']/.test(line) && asPath(line.replace(/\\(.)/g, '$1'))) out.push(asPath(line.replace(/\\(.)/g, '$1'))!);
    else return undefined;
  }
  return out.length <= MAX_PATHS ? out : undefined;
}
