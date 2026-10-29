/**
 * A kept table's typed cells, read the same way on the Mac and the phone (BLG-381, BLG-386): a
 * document's kind from its name and how a viewer shows it, what kind of file it is in words, and
 * each rich kind's value (progress, sparkline, delta, person, rating). Pure and browser-safe
 * (core/sentinel/columns.ts re-exports it; the phone's bundle reads src/shared).
 */

/** A document's kind for the viewer, from its name. */
export function documentMime(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

const MIME: Readonly<Record<string, string>> = { html: 'text/html', htm: 'text/html', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values', xml: 'text/xml', yaml: 'text/yaml', yml: 'text/yaml', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', zip: 'application/zip', gz: 'application/gzip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

/**
 * How the viewer shows a document: as a page (with nothing allowed to run), Markdown, JSON as a tree,
 * text, a picture, a PDF, a video or a sound; anything else (a zip, a Word file) only by what it is.
 */
export type DocumentLook = 'html' | 'markdown' | 'json' | 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'other';
export function documentLook(mime: string): DocumentLook {
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'application/json') return 'json';
  // An SVG can carry script: it's shown as a picture (an <img> runs none).
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

const KIND_WORDS: Readonly<Record<string, string>> = { 'application/zip': 'ZIP archive', 'application/gzip': 'Gzip archive', 'application/pdf': 'PDF document', 'text/html': 'Web page', 'text/markdown': 'Markdown', 'application/json': 'JSON', 'text/csv': 'CSV table', 'text/tab-separated-values': 'TSV table', 'text/plain': 'Plain text', 'image/svg+xml': 'SVG image', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation' };

/** What kind of file it is, in words ("PDF document", "PNG image", "DMG file"). */
export function kindWords(name: string, mime: string): string {
  if (KIND_WORDS[mime]) return KIND_WORDS[mime]!;
  const sub = mime.split('/')[1]?.replace(/^x-/, '').toUpperCase();
  if (/^(image|video|audio)\//.test(mime) && sub) return `${sub} ${mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio'}`;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toUpperCase();
  return ext ? `${ext} file` : 'File';
}

/** A progress cell's share, 0 to 1 (a number, "40%", "3/8"); none when it isn't one. */
export function progressOf(v: unknown, max = 100): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.min(1, v / (max || 100))) : undefined;
  if (typeof v !== 'string') return undefined;
  const frac = /^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(v);
  if (frac) return Number(frac[2]) > 0 ? Math.max(0, Math.min(1, Number(frac[1]) / Number(frac[2]))) : undefined;
  const pct = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/.exec(v);
  if (pct) return Math.max(0, Math.min(1, Number(pct[1]) / 100));
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? Math.max(0, Math.min(1, n / (max || 100))) : undefined;
}

/** A sparkline cell's numbers: a JSON list, or numbers apart by commas or spaces. */
export function sparkOf(v: unknown): number[] | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const t = String(v).trim();
  let list: unknown[];
  try {
    const j = JSON.parse(t) as unknown;
    list = Array.isArray(j) ? j : [];
  } catch {
    list = t.replace(/^\[|\]$/g, '').split(/[\s,;]+/);
  }
  const out = list.map((x) => (typeof x === 'number' ? x : Number(String(x)))).filter((x) => Number.isFinite(x));
  return out.length >= 2 ? out.slice(0, 120) : undefined;
}

/** A delta cell: its number and tone ("+12%", -3, "−$40"); none when it isn't one. */
export function deltaCellOf(v: unknown, better: 'up' | 'down' | 'none' = 'up'): { readonly text: string; readonly tone: 'good' | 'bad' | 'flat' | 'none' } | undefined {
  const t = typeof v === 'number' ? (v > 0 ? `+${v}` : String(v)) : typeof v === 'string' ? v.trim() : '';
  const n = Number(t.replace(/[−–]/g, '-').replace(/[^\d.+-]/g, ''));
  if (!t || !Number.isFinite(n)) return undefined;
  const tone = n === 0 ? 'flat' : better === 'none' ? 'none' : (n > 0) === (better !== 'down') ? 'good' : 'bad';
  return { text: typeof v === 'number' && v > 0 ? `+${v}` : t, tone };
}

/** A person cell: their name (an email's part before the @, said nicely) and initials. */
export function personOf(v: unknown): { readonly name: string; readonly initials: string; readonly email?: string } | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const t = v.trim();
  const mail = /^([^@\s<>]+)@[^@\s<>]+$/.exec(t) ?? /<([^@\s<>]+@[^@\s<>]+)>/.exec(t);
  const email = mail ? (mail[0].includes('<') ? mail[1] : t) : undefined;
  const raw = mail && !t.includes('<') ? mail[1]!.replace(/[._+-]+/g, ' ') : t.replace(/<[^>]*>/, '').trim();
  const name = raw.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return { name, initials, ...(email ? { email } : {}) };
}

/** A rating cell's stars, 0 to max (5 when none). */
export function ratingOf(v: unknown, max = 5): { readonly value: number; readonly max: number } | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const m = Math.max(1, Math.min(10, Math.round(max)));
  return { value: Math.max(0, Math.min(m, n)), max: m };
}

/**
 * A document as the viewer shows it: its own HTML with a policy in front that lets nothing load
 * (no scripts, no network; styles and pictures inside it only), whatever the document says.
 */
export function quietHtml(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'">`;
  // Before anything the document says (a <base>, a <meta refresh>, a script): the policy comes first.
  return `<!doctype html>${policy}${html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')}`;
}
