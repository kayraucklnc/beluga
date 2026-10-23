import type { LogItem } from './store.js';

/**
 * Saves the workspace conversations that changed, off the hot path: one pass over the log finds
 * them (an item replaced or added), only those are written, and the writes are async and never
 * overlap. Saves wait for a quiet moment, but constant streaming still saves every `maxWaitMs`.
 */

export interface HistorySaverDeps {
  /** The shared log, as it is now. */
  readonly log: () => readonly LogItem[];
  /** The conversations whose history is kept (the loaded workspace channels). */
  readonly channels: () => ReadonlySet<string>;
  /** The workspace a channel saves to (undefined: not saved). */
  readonly idOf: (channel: string) => string | undefined;
  /** Write one history; `current()` says right before the file is replaced whether it's still wanted. */
  readonly write: (id: string, items: readonly LogItem[], current: () => boolean) => Promise<void>;
  readonly writeSync: (id: string, items: readonly LogItem[]) => void;
  readonly now?: () => number;
  /** Quiet this long after the last change before saving (default 400 ms). */
  readonly quietMs?: number;
  /** Never more than this after the first unsaved change (default 2 s). */
  readonly maxWaitMs?: number;
  /** The most items kept per conversation (default 500). */
  readonly keep?: number;
}

const QUIET_MS = 400;
const MAX_WAIT_MS = 2000;
const KEEP = 500;

const sameItems = (a: readonly LogItem[] | undefined, b: readonly LogItem[]): boolean => Boolean(a) && a!.length === b.length && a!.every((x, i) => x === b[i]);

export class HistorySaver {
  private timer?: ReturnType<typeof setTimeout>;
  /** When the oldest unsaved change came (undefined: nothing waiting). */
  private dirtySince?: number;
  /** What was last written of each conversation (the very items, compared by identity). */
  private readonly saved = new Map<string, readonly LogItem[]>();
  /** Each conversation's latest write: an older one still in flight doesn't replace the file. */
  private readonly gen = new Map<string, number>();
  private inFlight?: Promise<void>;
  private again = false;

  constructor(private readonly deps: HistorySaverDeps) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The log changed: save after a quiet moment, and within maxWaitMs of the first change. */
  changed(): void {
    const now = this.now;
    this.dirtySince ??= now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.deps.quietMs ?? QUIET_MS, this.dirtySince + (this.deps.maxWaitMs ?? MAX_WAIT_MS) - now));
    this.timer = setTimeout(() => void this.save(), wait);
    this.timer.unref?.();
  }

  /** Whether a save is waiting to happen. */
  get pending(): boolean {
    return this.timer !== undefined;
  }

  /** The conversations whose items differ from what was last written, in one pass over the log. */
  changes(): Array<{ readonly channel: string; readonly id: string; readonly items: readonly LogItem[] }> {
    const channels = this.deps.channels();
    const by = new Map<string, LogItem[]>();
    for (const c of channels) if (this.deps.idOf(c)) by.set(c, []);
    for (const l of this.deps.log()) by.get(l.channel)?.push(l);
    for (const c of [...this.saved.keys()]) if (!by.has(c)) this.saved.delete(c);
    const keep = this.deps.keep ?? KEEP;
    const out: Array<{ channel: string; id: string; items: readonly LogItem[] }> = [];
    for (const [channel, all] of by) {
      const items = all.length > keep ? all.slice(-keep) : all;
      const saved = this.saved.get(channel);
      if (saved ? !sameItems(saved, items) : items.length > 0) out.push({ channel, id: this.deps.idOf(channel)!, items });
    }
    return out;
  }

  /** A conversation was just loaded from its file: what it holds now is what's saved. */
  loaded(channel: string): void {
    const keep = this.deps.keep ?? KEEP;
    const items = this.deps.log().filter((l) => l.channel === channel);
    this.saved.set(channel, items.length > keep ? items.slice(-keep) : items);
  }

  private bump(channel: string): number {
    const gen = (this.gen.get(channel) ?? 0) + 1;
    this.gen.set(channel, gen);
    return gen;
  }

  /** Write what changed (async; one save at a time: a change meanwhile saves again after it). */
  save(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirtySince = undefined;
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    const jobs = this.changes().map(({ channel, id, items }) => {
      const gen = this.bump(channel);
      const current = (): boolean => this.gen.get(channel) === gen && this.deps.channels().has(channel);
      return this.deps.write(id, items, current).then(
        () => {
          if (this.gen.get(channel) === gen) this.saved.set(channel, items);
        },
        () => undefined, // tried again with the next change
      );
    });
    if (!jobs.length) return Promise.resolve();
    const run = Promise.all(jobs).then(() => {
      this.inFlight = undefined;
      if (this.again) {
        this.again = false;
        this.changed();
      }
    });
    this.inFlight = run;
    return run;
  }

  /** Write what changed now, synchronously (before a fork copies the history, and on stop). */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirtySince = undefined;
    for (const { channel, id, items } of this.changes()) {
      this.bump(channel); // a write still in flight is older: it's dropped
      try {
        this.deps.writeSync(id, items);
        this.saved.set(channel, items);
      } catch {
        // tried again with the next change
      }
    }
  }

  stop(): void {
    if (this.timer || this.inFlight) this.flush();
  }
}
