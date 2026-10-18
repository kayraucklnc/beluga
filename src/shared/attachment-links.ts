import { ATTACHMENT_SCHEME } from '../core/attachment-share.js';

/**
 * Images linked in a chat message ("[📎 image 1 (png, 120K)](klaud-attachment:<owner>/<file>)"),
 * for screens that show the pictures themselves. Browser-safe.
 */

export interface LinkedImage {
  readonly href: string;
  /** Who has the file (a peer id). */
  readonly owner: string;
  readonly file: string;
  /** "image 1". */
  readonly label: string;
  /** "png, 120K", when the link says. */
  readonly detail?: string;
}

const LINK = new RegExp(`\\[([^\\]\\n]*)\\]\\((${ATTACHMENT_SCHEME}[^)\\s/]+/[^)\\s/]+)\\)`, 'g');

/** An image link's target as owner and file (undefined for anything else). */
export function parseAttachmentHref(href: string): { owner: string; file: string } | undefined {
  if (!href.startsWith(ATTACHMENT_SCHEME)) return undefined;
  const rest = href.slice(ATTACHMENT_SCHEME.length);
  const at = rest.indexOf('/');
  const owner = rest.slice(0, at);
  const file = rest.slice(at + 1);
  return at > 0 && file && !file.includes('/') ? { owner, file } : undefined;
}

function imageOf(text: string, href: string): LinkedImage | undefined {
  const target = parseAttachmentHref(href);
  if (!target) return undefined;
  const m = /image (\d+)(?: \(([^)]*)\))?/.exec(text);
  return { href, ...target, label: m ? `image ${m[1]}` : 'image', ...(m?.[2] ? { detail: m[2] } : {}) };
}

/**
 * The images a message links to (in order, once each) and its text to show with them: links at
 * the very start or end go (the pictures show below the text), ones mid-sentence become a short
 * "image N" link so the words still read.
 */
export function splitImages(text: string): { text: string; images: LinkedImage[] } {
  const found = [...text.matchAll(LINK)].flatMap((m) => {
    const image = imageOf(m[1] ?? '', m[2] ?? '');
    return image ? [{ start: m.index, end: m.index + m[0].length, image }] : [];
  });
  if (!found.length) return { text, images: [] };
  const blank = (s: string): boolean => !s.trim();
  // How many links open and close the message (with only spaces between them).
  let lead = 0;
  while (lead < found.length && blank(text.slice(lead ? found[lead - 1]!.end : 0, found[lead]!.start))) lead++;
  let trail = 0;
  while (trail < found.length - lead && blank(text.slice(found[found.length - 1 - trail]!.end, trail ? found[found.length - trail]!.start : text.length))) trail++;
  let out = '';
  let at = 0;
  found.forEach((f, i) => {
    out += text.slice(at, f.start);
    if (i >= lead && i < found.length - trail) out += `[${f.image.label}](${f.image.href})`;
    at = f.end;
  });
  out += text.slice(at);
  const all = found.map((f) => f.image);
  return { text: out.trim(), images: all.filter((img, i) => all.findIndex((x) => x.href === img.href) === i) };
}
