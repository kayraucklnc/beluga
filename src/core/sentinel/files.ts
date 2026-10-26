import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, safeName, writeJson } from '../../net/mesh/files.js';
import { DEFAULT_RUN_AT_ONCE, KEEP_IN_FILE, type RunSummary, type Sentinel, keepRuns } from './model.js';
import { SavedRunSchema, SavedSentinelSchema, SentinelFileSchema } from './schema.js';

/**
 * Where sentinels live: ~/.beluga/sentinel.json (the sentinels and the index of their runs,
 * readable only by you, written atomically after a short wait), and each run's outputs and report
 * in ~/.beluga/sentinel/runs/<runId>/ (trigger.json, step-<n>.txt, report.md). Without a folder
 * (tests, the demo) everything stays in memory.
 */

export interface SentinelData {
  readonly runAtOnce: number;
  readonly items: readonly Sentinel[];
  /** Oldest first. */
  readonly runs: readonly RunSummary[];
}

export const EMPTY_DATA: SentinelData = { runAtOnce: DEFAULT_RUN_AT_ONCE, items: [], runs: [] };

export class SentinelFile {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => SentinelData) | undefined;
  /** sentinel.json couldn't be read nor moved aside: nothing is written over it. */
  private readOnly = false;

  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
    private readonly delayMs = 300,
  ) {}

  get file(): string | undefined {
    return this.dir ? path.join(this.dir, 'sentinel.json') : undefined;
  }

  /** What's saved: each sentinel and run checked on its own; the ones that don't read are kept beside it. */
  load(): SentinelData {
    const file = this.file;
    if (!file || !existsSync(file)) return EMPTY_DATA;
    const parsed = SentinelFileSchema.safeParse(readJson(file));
    if (!parsed.success) {
      try {
        renameSync(file, `${file}.unreadable-${this.now()}`);
      } catch {
        this.readOnly = true;
      }
      return EMPTY_DATA;
    }
    const dropped: unknown[] = [];
    const items = parsed.data.items.flatMap((raw) => {
      const r = SavedSentinelSchema.safeParse(raw);
      if (!r.success) dropped.push(raw);
      return r.success ? [r.data as unknown as Sentinel] : [];
    });
    const ids = new Set(items.map((i) => i.id));
    const runs = parsed.data.runs.flatMap((raw) => {
      const r = SavedRunSchema.safeParse(raw);
      return r.success && ids.has(r.data.sentinelId) ? [r.data as unknown as RunSummary] : [];
    });
    if (dropped.length) {
      try {
        writeJson(path.join(this.dir!, `sentinel.dropped-${this.now()}.json`), dropped);
      } catch {
        // Nowhere to keep them: Sentinel goes on without them.
      }
    }
    return { runAtOnce: parsed.data.runAtOnce, items, runs };
  }

  /** Written a moment later (several changes in a row are one write). */
  save(data: () => SentinelData): void {
    if (!this.dir || this.readOnly) return;
    this.pending = data;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, this.delayMs);
    this.timer.unref?.();
  }

  /** Write anything waiting now (on the way out). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.write();
  }

  private write(): void {
    const data = this.pending?.();
    this.pending = undefined;
    const file = this.file;
    if (!data || !file) return;
    try {
      writeJson(file, { version: 1, runAtOnce: data.runAtOnce, items: data.items, runs: data.runs });
    } catch {
      // A full disk or a permission problem: the next change tries again.
    }
  }
}

/**
 * Per sentinel its last `keep` runs; the rest go, with their folders. Runs still going are never
 * pruned. → what's kept and the ids that went.
 */
export function pruneRuns<R extends { readonly id: string; readonly sentinelId: string; readonly state: string }>(runs: readonly R[], keep = KEEP_IN_FILE): { readonly kept: R[]; readonly gone: string[] } {
  const kept = keepRuns(runs, keep);
  const ids = new Set(kept.map((r) => r.id));
  const live = runs.filter((r) => !ids.has(r.id) && (r.state === 'running' || r.state === 'queued' || r.state === 'needs-you'));
  const all = live.length ? runs.filter((r) => ids.has(r.id) || live.includes(r)) : kept;
  const keptIds = new Set(all.map((r) => r.id));
  return { kept: all, gone: runs.filter((r) => !keptIds.has(r.id)).map((r) => r.id) };
}

/** A run's folder: its trigger, each step's whole output, its report. In memory without a home. */
export class RunFolders {
  private readonly memory = new Map<string, Map<string, string>>();

  constructor(private readonly dir: string | null) {}

  /** ~/.beluga/sentinel/runs (none in memory). */
  get root(): string | undefined {
    return this.dir ? path.join(this.dir, 'sentinel', 'runs') : undefined;
  }

  folder(runId: string): string | undefined {
    return this.root ? path.join(this.root, safeName(runId)) : undefined;
  }

  /** Where a file of a run is (none in memory). */
  pathOf(runId: string, name: string): string | undefined {
    const dir = this.folder(runId);
    return dir ? path.join(dir, name) : undefined;
  }

  write(runId: string, name: string, text: string): void {
    const dir = this.folder(runId);
    if (!dir) {
      const files = this.memory.get(runId) ?? new Map<string, string>();
      files.set(name, text);
      this.memory.set(runId, files);
      return;
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, name), text, { mode: 0o600 });
    } catch {
      // Kept in the index without it.
    }
  }

  read(runId: string, name: string): string | undefined {
    const dir = this.folder(runId);
    if (!dir) return this.memory.get(runId)?.get(name);
    try {
      return readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return undefined;
    }
  }

  remove(runId: string): void {
    this.memory.delete(runId);
    const dir = this.folder(runId);
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}
