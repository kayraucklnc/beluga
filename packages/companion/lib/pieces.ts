/**
 * A whole file fetched piece by piece (BLG-106): the Mac answers each `get {ref, variant, off}`
 * with one piece of at most COMPANION_PIECE bytes (src/companion/files.ts), so a big picture (a
 * Retina screenshot, an animated GIF) takes many asks, each for the next offset. This decides what
 * to ask for next and when it's done, and never waits for ever: a piece that doesn't come in
 * PIECE_TIMEOUT_MS fails the fetch with words and a Retry. Pure: the store does the asking.
 */

/** A piece that hasn't come by then fails the fetch (the viewer offers Retry). */
export const PIECE_TIMEOUT_MS = 20_000;
/** A full picture bigger than this stays the preview (its thumbnail): open it on your Mac. */
export const MAX_FULL_BYTES = 64 * 1024 * 1024;

/** Bytes a base64 string holds. */
export function b64Bytes(b64: string): number {
  const n = b64.length;
  if (!n) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((n * 3) / 4) - pad;
}

export interface ChunkIn {
  readonly off: number;
  readonly b64: string;
  readonly eof: boolean;
  readonly size: number;
}

export type Step =
  /** Ask for the piece from `off`. */
  | { readonly t: 'next'; readonly off: number; readonly got: number; readonly size: number }
  | { readonly t: 'done'; readonly got: number; readonly size: number }
  | { readonly t: 'fail'; readonly error: string };

/** Where a fetch is: what came, in order, and what to ask for next. */
export class Assembly {
  got = 0;
  size: number | undefined;

  constructor(private readonly max = MAX_FULL_BYTES) {}

  /** A piece came: what now. */
  add(c: ChunkIn): Step {
    if (c.off !== this.got) return { t: 'fail', error: 'The pieces came out of order. Try again.' };
    if (c.size > this.max) return { t: 'fail', error: `Too big for the phone (${Math.round(c.size / 1024 / 1024)} MB). Open it on your Mac.` };
    this.size = c.size;
    const n = b64Bytes(c.b64);
    this.got += n;
    if (c.eof || this.got >= c.size) return { t: 'done', got: this.got, size: c.size };
    // A piece with nothing in it, before the end: the file shrank under us.
    if (!n) return { t: 'fail', error: 'The file changed while it came. Try again.' };
    return { t: 'next', off: this.got, got: this.got, size: c.size };
  }

  /** How far, 0–1 (0 until the size is known). */
  get progress(): number {
    return this.size ? Math.min(1, this.got / this.size) : 0;
  }
}

/** "Getting the full picture · 2.1 of 8.4 MB" */
export function progressText(got: number, size: number | undefined): string {
  if (!size) return 'Getting the full picture';
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);
  return size < 1024 * 1024 ? `Getting the full picture · ${Math.round((got / size) * 100)}%` : `Getting the full picture · ${mb(got)} of ${mb(size)} MB`;
}
