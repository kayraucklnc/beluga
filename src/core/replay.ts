import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Messages that make this computer do something must be this fresh (sender's clock, signed). */
export const FRESH_MS = 10 * 60_000;

/**
 * Remembers recent requests (by their signed id) across restarts, so one captured earlier can't
 * be replayed to you later, not even by the host relaying the room. Anything older than the
 * freshness window is refused anyway, so that's all it needs to remember.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly file?: string,
    private readonly windowMs = FRESH_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [id, at] of Object.entries(raw)) if (typeof at === 'number') this.seen.set(id, at);
      this.prune();
    } catch {
      // Nothing remembered yet.
    }
  }

  /** True when the message is fresh and new (it's then remembered); false for stale or repeated ones. */
  admit(id: string, sentAt: number): boolean {
    const now = this.now();
    if (Math.abs(now - sentAt) > this.windowMs) return false;
    if (this.seen.has(id)) return false;
    this.seen.set(id, sentAt);
    this.schedule();
    return true;
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs * 2;
    for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
  }

  private schedule(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 500);
    this.timer.unref?.();
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file) return;
    this.prune();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.seen)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Best effort: the freshness window still applies.
    }
  }
}
