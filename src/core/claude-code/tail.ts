import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Reads an append-only file a little at a time: the first read takes only its end (a transcript
 * can be 60 MB), every read after that only what was added. Only whole lines count: an unfinished
 * last line waits for the next read. Never writes. A file that shrank (replaced) is read again
 * from its end.
 */
export interface TailOptions {
  /** How much of the end the first read takes (default 2 MB). */
  readonly firstBytes?: number;
  /** The most one later read takes; a bigger jump skips ahead to the newest part (default 8 MB). */
  readonly maxBytes?: number;
}

const FIRST = 2 * 1024 * 1024;
const MAX = 8 * 1024 * 1024;
const NL = 0x0a;

export class Tail {
  /** Where the next whole line starts (-1: not read yet). */
  private offset = -1;
  /** The file's size at the last read. */
  private seen = -1;
  /** Its modification time at the last read (epoch ms). */
  mtime = 0;

  constructor(
    readonly file: string,
    private readonly opts: TailOptions = {},
  ) {}

  /** Lines added since the last read; [] when nothing changed or the file is gone. */
  read(): string[] {
    let fd: number;
    try {
      fd = openSync(this.file, 'r');
    } catch {
      return [];
    }
    try {
      const st = fstatSync(fd);
      this.mtime = st.mtimeMs;
      if (st.size === this.seen) return [];
      this.seen = st.size;
      const first = this.offset < 0 || st.size < this.offset;
      const limit = first ? (this.opts.firstBytes ?? FIRST) : (this.opts.maxBytes ?? MAX);
      let start = first ? 0 : this.offset;
      // Starting mid-file (or skipping ahead): the first, partial line is dropped.
      const partial = st.size - start > limit;
      if (partial) start = st.size - limit;
      const length = st.size - start;
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      const last = got ? buf.lastIndexOf(NL, got - 1) : -1;
      if (last < 0) {
        this.offset = start;
        return [];
      }
      this.offset = start + last + 1;
      let text = buf.subarray(0, last + 1).toString('utf8');
      if (partial) text = text.slice(text.indexOf('\n') + 1);
      return text.split('\n').filter((l) => l.trim());
    } catch {
      return [];
    } finally {
      closeSync(fd);
    }
  }
}

/** The whole lines in the first `max` bytes of a file (how a transcript starts: its folder, first message). */
export function headLines(file: string, max = 256 * 1024): string[] {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    const last = n ? buf.lastIndexOf(NL, n - 1) : -1;
    return last > 0 ? buf.subarray(0, last).toString('utf8').split('\n').filter((l) => l.trim()) : [];
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}
