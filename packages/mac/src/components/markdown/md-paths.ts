/**
 * Where a link or an image in a Markdown file points, the way GitHub reads it: relative to the
 * file's folder, `/…` from the top of the folder it lives in (the repo), `#…` within the page.
 * Plain data, no DOM: the reader decides what to do with the answer.
 */

/** What a link in a document opens. Paths are relative to the share (no leading slash). */
export type DocLink =
  | { readonly kind: 'anchor'; readonly hash: string }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'doc'; readonly path: string; readonly hash?: string }
  | { readonly kind: 'file'; readonly path: string; readonly line?: number }
  | { readonly kind: 'dir'; readonly path: string }
  | { readonly kind: 'blocked' };

/** Where an image's bytes come from. */
export type DocImage = { readonly kind: 'remote'; readonly url: string } | { readonly kind: 'local'; readonly path: string } | { readonly kind: 'blocked' };

/** The prefix rehype-sanitize gives ids that came from the document (GitHub does the same). */
export const USER_CONTENT = 'user-content-';

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd|mdx)$/i;
const EXTERNAL = /^(https?:|mailto:)/i;
/** Any scheme (`javascript:`, `file:`, `data:`…). Only the ones above leave the app. */
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|svg|webp)$/i;

export const isMarkdownPath = (p: string): boolean => MARKDOWN_FILE.test(p);
export const isImageFile = (p: string): boolean => IMAGE_FILE.test(p);
/** A video the reader and Outputs play (BLG-100). */
export const isVideoFile = (p: string): boolean => /\.(mp4|m4v|mov|webm)$/i.test(p);

/** The folder a share-relative file is in ('' at the top). */
export const dirOf = (file: string): string => {
  const at = file.lastIndexOf('/');
  return at < 0 ? '' : file.slice(0, at);
};

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * `rel` taken from the folder `dir` (both share-relative), with `.` and `..` worked out.
 * A leading `/` starts at the top of the share. Undefined when it climbs out of the share.
 */
export function joinPath(dir: string, rel: string): string | undefined {
  const start = rel.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  const parts = rel.split('/').reduce<string[] | undefined>((acc, part) => {
    if (!acc) return undefined;
    if (part === '' || part === '.') return acc;
    if (part === '..') return acc.length ? acc.slice(0, -1) : undefined;
    return [...acc, part];
  }, start);
  return parts?.join('/');
}

/** `path?query#hash` → its parts (the query is dropped: `?raw=true`, `?plain=1`). */
function splitHref(href: string): { path: string; hash: string } {
  const hashAt = href.indexOf('#');
  const hash = hashAt < 0 ? '' : href.slice(hashAt + 1);
  const beforeHash = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  return { path: queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt), hash };
}

/** GitHub's `#L12` line anchors on links to code. */
const lineOf = (hash: string): number | undefined => {
  const m = /^L(\d+)/.exec(hash);
  return m ? Number(m[1]) : undefined;
};

/** What clicking `href` in the document at `docPath` should open. */
export function resolveLink(href: string, docPath: string): DocLink {
  const raw = href.trim();
  if (!raw) return { kind: 'blocked' };
  if (raw.startsWith('#')) return raw.length > 1 ? { kind: 'anchor', hash: decode(raw.slice(1)) } : { kind: 'blocked' };
  if (EXTERNAL.test(raw)) return { kind: 'external', url: raw };
  if (SCHEME.test(raw) || raw.startsWith('//')) return { kind: 'blocked' };
  const { path: rel, hash } = splitHref(raw);
  const target = joinPath(dirOf(docPath), decode(rel));
  if (target === undefined) return { kind: 'blocked' };
  // A link to this very page with a section: stay here.
  if (target === docPath && hash) return { kind: 'anchor', hash: decode(hash) };
  if (rel.endsWith('/') || target === '') return { kind: 'dir', path: target };
  if (isMarkdownPath(target)) return hash ? { kind: 'doc', path: target, hash: decode(hash) } : { kind: 'doc', path: target };
  const line = lineOf(hash);
  return line ? { kind: 'file', path: target, line } : { kind: 'file', path: target };
}

/** Where the image `src` in the document at `docPath` is read from. */
export function resolveImage(src: string, docPath: string): DocImage {
  const raw = src.trim();
  if (!raw) return { kind: 'blocked' };
  if (/^https:\/\//i.test(raw)) return { kind: 'remote', url: raw };
  // Plain http and every other scheme (file:, data:, javascript:) stay out.
  if (SCHEME.test(raw) || raw.startsWith('//')) return { kind: 'blocked' };
  const target = joinPath(dirOf(docPath), decode(splitHref(raw).path));
  return target && isImageFile(target) ? { kind: 'local', path: target } : { kind: 'blocked' };
}

/** The element ids a `#hash` can mean: the heading's own id, or a footnote's (sanitized ids carry a prefix). */
export const anchorIds = (hash: string): string[] => {
  const h = hash.replace(/^#/, '');
  return h.startsWith(USER_CONTENT) ? [h, h.slice(USER_CONTENT.length)] : [h, `${USER_CONTENT}${h}`, h.toLowerCase()];
};
