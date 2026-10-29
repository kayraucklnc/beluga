import type { Cell, Row } from '../../shared/view-spec.js';

/**
 * Typed columns of a rows metric (docs/sentinel.md §10, BLG-345): what kind of value a column holds,
 * so a document shows as a chip that opens it rather than as a dump of its text. The pure part,
 * browser-safe: the types, the storage cell, the documents a run's rows hold (taken out of the rows,
 * their names and bytes; sentinels.ts writes them to the run's folder), and the preview's words.
 *
 * - `html` / `file`: the value is a document. It's written to `runs/<run>/files/<name>` and the cell
 *   keeps only its name; the chip opens it (a viewer with scripts and the network off, or the default app).
 * - `storage`: a Supabase Storage object, from a bucket and a path column (or a bucket's own name). The
 *   cell is `<bucket>/<path>`; its link is signed only when it's clicked, for about a minute.
 * - `url`, `path`: declared, so nothing has to guess from the value.
 * - The table's own kinds (BLG-349): text, number, percent, currency, bytes, date, datetime, bool,
 *   badge, color, image, code; and progress (a bar, 0…max), sparkline (a list of numbers), delta (a
 *   change, green or rose by `better`), person (a name or email, with its initials), rating (stars,
 *   0…max), action (a button that runs another sentinel with the row as its trigger's payload).
 */

/** Kinds whose value is a document or a storage object (a chip that opens it). */
export const DOCUMENT_KINDS = ['html', 'file', 'storage'] as const;
/** Kinds the chat's table already draws (view-spec COLUMN_TYPES): a column is shown as one of these. */
export const VIEW_KINDS = ['text', 'number', 'percent', 'currency', 'bytes', 'date', 'datetime', 'bool', 'url', 'path', 'color', 'image', 'code', 'badge'] as const;
/** Kinds only a kept table draws. */
export const RICH_KINDS = ['progress', 'sparkline', 'delta', 'person', 'rating', 'action'] as const;
export const COLUMN_KINDS = [...DOCUMENT_KINDS, ...VIEW_KINDS, ...RICH_KINDS] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];
export type ViewKind = (typeof VIEW_KINDS)[number];
export type RichKind = (typeof RICH_KINDS)[number];
export const isViewKind = (t: ColumnKind): t is ViewKind => (VIEW_KINDS as readonly string[]).includes(t);
export const isRichKind = (t: ColumnKind): t is RichKind => (RICH_KINDS as readonly string[]).includes(t);

/** One typed column of a rows metric. */
export interface MetricColumn {
  /** The column (for storage: the new column the chip goes in). */
  readonly key: string;
  readonly type: ColumnKind;
  /** Its heading ("Translation"). */
  readonly label?: string;
  /** A document's file name, with `{{column}}` from its row ("{{file}}.html"); `{{row}}` is its number. */
  readonly name?: string;
  /** Storage: the column holding the bucket, or the bucket's own name. */
  readonly bucket?: string;
  /** Storage: the column holding the object's path. */
  readonly path?: string;
  /**
   * A file's value: `auto` (text as it is; a data: URL or Postgres bytea as its bytes), or plain
   * `base64` / `hex` for a column that holds bytes so.
   */
  readonly encoding?: ColumnEncoding;
  /** currency: its code ("EUR", USD when none). */
  readonly currency?: string;
  /** number, percent, currency: digits after the point. */
  readonly decimals?: number;
  /** progress and rating: the most (100 and 5 when none). */
  readonly max?: number;
  /** delta: which way is good (up when none). */
  readonly better?: 'up' | 'down' | 'none';
  /** action: the sentinel it runs (its id or name; kept as its id), and the button's words ("Retry"). */
  readonly sentinel?: string;
  readonly button?: string;
}

export const COLUMN_ENCODINGS = ['auto', 'text', 'base64', 'hex'] as const;
export type ColumnEncoding = (typeof COLUMN_ENCODINGS)[number];

/** Documents are kept this many days by default (a step's filesKeepDays). */
export const FILES_KEEP_DAYS = 14;
export const FILES_KEEP_MAX = 365;
/** A document bigger than this isn't kept (its cell says so). */
export const DOCUMENT_MAX = 10 * 1024 * 1024;
/** The folder in a run's folder where its documents are. */
export const FILES_DIR = 'files';
/** How long a signed storage link lasts. */
export const SIGNED_SECONDS = 60;
/** The most of a storage object Beluga fetches to show or open (a bigger one: open its link). */
export const STORAGE_MAX = 50 * 1024 * 1024;

export const isDocumentKind = (t: ColumnKind): boolean => t === 'html' || t === 'file';

/**
 * A document as the viewer reads it (a kept one, or a storage object fetched now): its name, kind and
 * size; text for text, base64 for the rest; neither when it's too big to send (`tooBig`).
 */
export interface DocumentRead {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly text?: string;
  readonly base64?: string;
  readonly cut?: boolean;
  readonly tooBig?: boolean;
  readonly runId: string;
  readonly at?: number;
}

/** A document taken out of a row: its file name, its contents, its size. */
export interface DocumentFile {
  readonly column: string;
  readonly name: string;
  /** Text as it came, or bytes (a data: URL, Postgres bytea). */
  readonly data: string | Uint8Array;
  readonly bytes: number;
}

/** What a typed document column held this run: how many documents, how many bytes. */
export interface DocumentCount {
  readonly column: string;
  readonly count: number;
  readonly bytes: number;
  /** Values too big to keep. */
  readonly tooBig?: number;
}

const encoder = new TextEncoder();

/** A file name that's safe on its own: no folders, no dots at the start, at most 100 characters. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[^\w.\- ()]+/g, '-')
    .replace(/^[.\s-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'document';
  if (clean.length <= 100) return clean;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(clean)?.[0] ?? '';
  return `${clean.slice(0, 100 - ext.length)}${ext}`;
}

/** A row's value as text for a name template. */
const said = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The file name of a row's document: the column's template filled in, its extension added when it has none. */
export function documentName(col: MetricColumn, row: Readonly<Record<string, unknown>>, index: number, ext: string): string {
  const filled = (col.name ?? '')
    .replace(/\{\{\s*row\s*\}\}/g, String(index + 1))
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k: string) => said(row[k]).slice(0, 80))
    .trim();
  const name = safeFileName(filled || `${col.key}-${index + 1}`);
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}${ext}`;
}

/**
 * Bytes from a value that carries them: a data: URL (base64) or Postgres bytea (`\x…` hex), or as
 * the column says (`base64`, `hex`). Text stays text.
 */
export function documentBytes(v: string, encoding: ColumnEncoding = 'auto'): { readonly bytes: Uint8Array; readonly ext: string } | undefined {
  if (encoding === 'text') return undefined;
  if (encoding === 'base64' && !v.startsWith('data:')) {
    try {
      const out = Uint8Array.from(atob(v.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      return { bytes: out, ext: sniff(out) };
    } catch {
      return undefined;
    }
  }
  if (encoding === 'hex' && /^(\\x)?([0-9a-f]{2})+$/i.test(v.trim())) {
    const hex = v.trim().replace(/^\\x/, '');
    return { bytes: hexBytes(hex), ext: sniff(hexBytes(hex)) };
  }
  const data = /^data:([\w.+-]+\/[\w.+-]+)?(;[^,]*)?;base64,([A-Za-z0-9+/=\s]*)$/.exec(v);
  if (data) {
    try {
      const bin = atob(data[3]!.replace(/\s+/g, ''));
      return { bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)), ext: EXT[data[1] ?? ''] ?? '.bin' };
    } catch {
      return undefined;
    }
  }
  if (/^\\x([0-9a-f]{2})*$/i.test(v) && v.length > 2) {
    const out = hexBytes(v.slice(2));
    return { bytes: out, ext: sniff(out) };
  }
  return undefined;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const EXT: Readonly<Record<string, string>> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'text/html': '.html', 'text/plain': '.txt', 'application/json': '.json', 'text/csv': '.csv', 'text/markdown': '.md' };

/** A few kinds known by their first bytes. */
function sniff(b: Uint8Array): string {
  const start = String.fromCharCode(...b.slice(0, 8));
  if (start.startsWith('%PDF')) return '.pdf';
  if (start.startsWith('\x89PNG')) return '.png';
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg';
  if (start.startsWith('GIF8')) return '.gif';
  if (start.startsWith('PK\x03\x04')) return '.zip';
  if (start.startsWith('\x1f\x8b')) return '.gz';
  if (start.startsWith('RIFF') && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return '.webp';
  if (b.slice(0, 64).every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127))) return '.txt';
  return '.bin';
}

/** A text value's extension: what an html column holds, else what it reads like. */
const textExt = (type: ColumnKind, v: string): string => {
  if (type === 'html') return '.html';
  const t = v.trimStart();
  if (/^<(!doctype html|html|body|div|p|h\d)\b/i.test(t)) return '.html';
  if (/^[[{]/.test(t)) return '.json';
  return '.txt';
};

/** A storage object's bucket or path: the column it names in the row, else the bucket's own name. */
function fromRow(row: Readonly<Record<string, unknown>>, ref: string | undefined, literal: boolean): string {
  if (!ref) return '';
  if (Object.hasOwn(row, ref)) return said(row[ref]).trim();
  return literal ? ref.trim() : '';
}

/** A storage cell: `<bucket>/<path>` (a bucket's name has no slash). */
export const storageCell = (bucket: string, objectPath: string): string => `${bucket}/${objectPath.replace(/^\/+/, '')}`;

/** A storage cell's bucket and path (none when it isn't one). */
export function splitStorage(cell: unknown): { readonly bucket: string; readonly path: string } | undefined {
  if (typeof cell !== 'string') return undefined;
  const at = cell.indexOf('/');
  if (at <= 0 || at === cell.length - 1) return undefined;
  const bucket = cell.slice(0, at);
  const objectPath = cell.slice(at + 1);
  if (!/^[\w.-]{1,100}$/.test(bucket) || objectPath.split('/').some((p) => p === '..')) return undefined;
  return { bucket, path: objectPath };
}

/** The columns a storage column reads its bucket and path from (the table hides them: the chip says it). */
export function storageSources(columns: readonly MetricColumn[] | undefined, present: readonly string[]): string[] {
  const has = new Set(present);
  return (columns ?? []).flatMap((c) => (c.type === 'storage' ? [c.bucket, c.path].filter((k): k is string => Boolean(k && has.has(k) && k !== c.key)) : []));
}

/**
 * Storage cells filled in (each storage column from its row's bucket and path); every other column
 * as it is. The rows' columns gain the storage ones.
 */
export function withStorage(rows: readonly Row[], columns: readonly string[], typed: readonly MetricColumn[] | undefined): { readonly rows: Row[]; readonly columns: string[] } {
  const storage = (typed ?? []).filter((c) => c.type === 'storage');
  if (!storage.length) return { rows: [...rows], columns: [...columns] };
  const out = rows.map((r) => {
    const next: Record<string, Cell> = { ...r };
    for (const c of storage) {
      const bucket = fromRow(r, c.bucket, true);
      const objectPath = fromRow(r, c.path, false);
      next[c.key] = bucket && objectPath ? storageCell(bucket, objectPath) : null;
    }
    return next;
  });
  return { rows: out, columns: [...columns, ...storage.map((c) => c.key).filter((k) => !columns.includes(k))] };
}

/**
 * A run's documents taken out of its rows: each html or file cell becomes its file's name (unique
 * among `taken`, the names this run gave already), and the files to write. A value too big is left
 * out (its cell empty); an empty one stays empty.
 */
export function takeDocuments(rows: readonly Row[], typed: readonly MetricColumn[] | undefined, taken: Set<string> = new Set()): { readonly rows: Row[]; readonly files: DocumentFile[]; readonly counts: DocumentCount[] } {
  const docs = (typed ?? []).filter((c) => isDocumentKind(c.type));
  if (!docs.length) return { rows: [...rows], files: [], counts: [] };
  const files: DocumentFile[] = [];
  const counts = new Map(docs.map((c) => [c.key, { column: c.key, count: 0, bytes: 0, tooBig: 0 }]));
  const out = rows.map((r, i) => {
    const next: Record<string, Cell> = { ...r };
    for (const c of docs) {
      const v = r[c.key];
      if (v === null || v === undefined || v === '') continue;
      const text = typeof v === 'string' ? v : String(v);
      const bin = c.type === 'file' ? documentBytes(text, c.encoding) : undefined;
      const bytes = bin ? bin.bytes.byteLength : encoder.encode(text).byteLength;
      const n = counts.get(c.key)!;
      if (bytes > DOCUMENT_MAX) {
        n.tooBig++;
        next[c.key] = null;
        continue;
      }
      let name = documentName(c, r, i, bin?.ext ?? textExt(c.type, text));
      for (let k = 2; taken.has(name.toLowerCase()); k++) name = name.replace(/(-\d+)?(\.[A-Za-z0-9]{1,8})?$/, (_m, _d, ext: string | undefined) => `-${k}${ext ?? ''}`);
      taken.add(name.toLowerCase());
      files.push({ column: c.key, name, data: bin ? bin.bytes : text, bytes });
      n.count++;
      n.bytes += bytes;
      next[c.key] = name;
    }
    return next;
  });
  return { rows: out, files, counts: [...counts.values()].map(({ tooBig, ...c }) => (tooBig ? { ...c, tooBig } : c)) };
}

/** What a run's typed document columns hold, without taking them out (the preview). */
export const documentCounts = (rows: readonly Row[], typed: readonly MetricColumn[] | undefined): DocumentCount[] => takeDocuments(rows, typed).counts;

/** A size in words: "81 KB", "1.2 MB", "640 B". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** A typed column in the preview's words: "html_content → 6 documents, 81 KB", "source → 6 storage objects, signed when clicked". */
export function typedWords(rows: readonly Row[], typed: readonly MetricColumn[] | undefined): string[] {
  const counts = new Map(documentCounts(rows, typed).map((c) => [c.column, c]));
  return (typed ?? []).map((c) => {
    if (isDocumentKind(c.type)) {
      const n = counts.get(c.key);
      if (!n?.count) return `${c.key} → no documents${n?.tooBig ? ` (${n.tooBig} over ${sizeWords(DOCUMENT_MAX)}, not kept)` : ' (the column is empty or missing)'}`;
      return `${c.key} → ${n.count} ${n.count === 1 ? 'document' : 'documents'}, ${sizeWords(n.bytes)}${n.tooBig ? ` (${n.tooBig} over ${sizeWords(DOCUMENT_MAX)}, not kept)` : ''}`;
    }
    if (c.type === 'storage') {
      const filled = withStorage(rows, [], [c]).rows.filter((r) => r[c.key] !== null).length;
      return filled ? `${c.key} → ${filled} storage ${filled === 1 ? 'object' : 'objects'} from ${c.bucket ?? '?'} / ${c.path ?? '?'}, signed when clicked` : `${c.key} → no storage objects: check bucket (${c.bucket ?? 'missing'}) and path (${c.path ?? 'missing'}) name columns that are in the rows`;
    }
    const filled = rows.filter((r) => r[c.key] !== null && r[c.key] !== undefined && r[c.key] !== '').length;
    return `${c.key} → ${c.type} (${filled} of ${rows.length} filled)`;
  });
}

/** The chip's words for a storage cell: the object's file name. */
export const storageName = (cell: unknown): string => {
  const s = splitStorage(cell);
  return s ? (s.path.split('/').pop() ?? s.path) : typeof cell === 'string' ? cell : '';
};

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

/**
 * A document as the viewer shows it: its own HTML with a policy in front that lets nothing load
 * (no scripts, no network; styles and pictures inside it only), whatever the document says.
 */
export function quietHtml(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'">`;
  // Before anything the document says (a <base>, a <meta refresh>, a script): the policy comes first.
  return `<!doctype html>${policy}${html.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')}`;
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
export function deltaCellOf(v: unknown, better: MetricColumn['better'] = 'up'): { readonly text: string; readonly tone: 'good' | 'bad' | 'flat' | 'none' } | undefined {
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

/** Two rows are the same row: every column equal (how an action names the row it runs with). */
export function sameRow(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => (a[k] ?? null) === (b[k] ?? null));
}
