/**
 * Images in a chat message's Markdown (`![alt](src)`), as plain data: a file on this Mac named
 * by its path (how Claude shows a screenshot it took), a web image, or something there's no way
 * to show. No DOM here, so it's tested on its own.
 */

export type ImageSource = { readonly kind: 'local'; readonly path: string } | { readonly kind: 'remote'; readonly url: string } | { readonly kind: 'other' };

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

const decode = (s: string): string => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};

/** What an image's `src` points at. */
export function imageSource(src: string): ImageSource {
  const raw = src.trim();
  if (/^https:\/\//i.test(raw)) return { kind: 'remote', url: raw };
  const path = decode(raw.replace(/^file:\/\//i, ''));
  return path.startsWith('/') && IMAGE.test(path) ? { kind: 'local', path } : { kind: 'other' };
}

/** A local image as the thumbnails and the lightbox take it (a `ChatImage`, see images.ts). */
export interface LocalImage {
  readonly href: string;
  readonly owner: string;
  readonly file: string;
  readonly label: string;
  readonly local: string;
}

const fileName = (path: string): string => path.split('/').pop() || path;

/** One local image as the lightbox and thumbnails know it. */
export const localImage = (path: string, alt: string): LocalImage => ({ href: `local:${path}`, owner: '', file: fileName(path), label: alt.trim() || fileName(path), local: path });

/** `![alt](<src> "title")` or `![alt](src "title")`. */
const MD_IMAGE = /!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g;

/** Code (fenced or inline) says how to write an image; it doesn't show one. */
const withoutCode = (text: string): string => text.replace(/```[\s\S]*?(```|$)/g, '').replace(/`[^`\n]*`/g, '');

/** The local images a message shows, in order, once each: the lightbox steps through them. */
export function messageImages(text: string): LocalImage[] {
  const seen = new Set<string>();
  const out: LocalImage[] = [];
  for (const m of withoutCode(text).matchAll(MD_IMAGE)) {
    const src = imageSource(m[2] ?? m[3] ?? '');
    if (src.kind !== 'local' || seen.has(src.path)) continue;
    seen.add(src.path);
    out.push(localImage(src.path, m[1] ?? ''));
  }
  return out;
}
