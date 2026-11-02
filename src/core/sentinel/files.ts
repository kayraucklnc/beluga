import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson, safeName, writeJson } from '../../net/mesh/files.js';
import { FILES_DIR, safeFileName } from './columns.js';
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
  /** What each event sentinel saw last, by sentinel (its trigger's cursor). */
  readonly cursors?: Readonly<Record<string, unknown>>;
  /** Webhook sentinels' secrets, by sentinel (never in the state). */
  readonly secrets?: Readonly<Record<string, string>>;
  /** The secrets GitHub signs their posts with (apart from the URL's), by sentinel (never in the state). */
  readonly signingSecrets?: Readonly<Record<string, string>>;
  /**
   * The load lost something: the file was set aside (or couldn't be), or sentinels or runs didn't
   * read. Their runs' folders may still be someone's, so nothing is swept on this start.
   */
  readonly lossy?: boolean;
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
      return { ...EMPTY_DATA, lossy: true };
    }
    const dropped: unknown[] = [];
    const items = parsed.data.items.flatMap((raw) => {
      const r = SavedSentinelSchema.safeParse(raw);
      if (!r.success) dropped.push(raw);
      return r.success ? [r.data as unknown as Sentinel] : [];
    });
    const ids = new Set(items.map((i) => i.id));
    // A dropped sentinel's runs (and runs that don't read) go beside it with it: their folders stay.
    const droppedRuns: unknown[] = [];
    const runs = parsed.data.runs.flatMap((raw) => {
      const r = SavedRunSchema.safeParse(raw);
      if (r.success && ids.has(r.data.sentinelId)) return [r.data as unknown as RunSummary];
      droppedRuns.push(raw);
      return [];
    });
    if (dropped.length || droppedRuns.length) {
      try {
        writeJson(path.join(this.dir!, `sentinel.dropped-${this.now()}.json`), { items: dropped, runs: droppedRuns });
      } catch {
        // Nowhere to keep them: Sentinel goes on without them, and never writes over the file that has them.
        this.readOnly = true;
      }
    }
    const keep = <T,>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([id]) => ids.has(id)));
    return { runAtOnce: parsed.data.runAtOnce, items, runs, cursors: keep(parsed.data.cursors), secrets: keep(parsed.data.secrets), signingSecrets: keep(parsed.data.signingSecrets), ...(dropped.length || droppedRuns.length ? { lossy: true } : {}) };
  }

  /**
   * What earlier loads set aside: the runs in sentinel.dropped-*.json (their folders are kept), and
   * whether an unreadable sentinel.json is there (`all`: then no folder is swept, any could be its).
   */
  setAside(): { readonly all: boolean; readonly ids: ReadonlySet<string> } {
    const ids = new Set<string>();
    if (!this.dir) return { all: false, ids };
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { all: true, ids };
    }
    if (names.some((n) => n.startsWith('sentinel.json.unreadable-'))) return { all: true, ids };
    for (const name of names) {
      if (!/^sentinel\.dropped-.*\.json$/.test(name)) continue;
      const saved = readJson(path.join(this.dir, name)) as { runs?: unknown } | undefined;
      // A file that doesn't read: any folder could be one of its runs'.
      if (!saved || typeof saved !== 'object') return { all: true, ids };
      for (const r of Array.isArray(saved.runs) ? saved.runs : []) if (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string') ids.add((r as { id: string }).id);
    }
    return { all: false, ids };
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
      writeJson(file, { version: 1, runAtOnce: data.runAtOnce, items: data.items, runs: data.runs, cursors: data.cursors ?? {}, secrets: data.secrets ?? {}, signingSecrets: data.signingSecrets ?? {} });
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

/** A run's folder: its trigger, each step's whole output, its report, its documents (files/). In memory without a home. */
export class RunFolders {
  private readonly memory = new Map<string, Map<string, string>>();
  private readonly documents = new Map<string, Map<string, string | Uint8Array>>();

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

  /** → whether it was kept (false: the disk said no). */
  write(runId: string, name: string, text: string): boolean {
    const dir = this.folder(runId);
    if (!dir) {
      const files = this.memory.get(runId) ?? new Map<string, string>();
      files.set(name, text);
      this.memory.set(runId, files);
      return true;
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, name), text, { mode: 0o600 });
      return true;
    } catch {
      // Kept in the index without it.
      return false;
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

  /**
   * What a run kept, for you to look at (BLG-392): its report, each step's output, its documents
   * (`files/<name>`), with their sizes. Never its trigger (a payload can carry what it was sent).
   */
  list(runId: string): Array<{ readonly name: string; readonly size: number }> {
    const shown = (n: string): boolean => n === 'report.md' || /^step-\d+\.txt$/.test(n);
    const dir = this.folder(runId);
    if (!dir) {
      const texts = [...(this.memory.get(runId) ?? [])].filter(([n]) => shown(n)).map(([name, t]) => ({ name, size: Buffer.byteLength(t) }));
      const docs = [...(this.documents.get(runId) ?? [])].map(([n, d]) => ({ name: `${FILES_DIR}/${n}`, size: typeof d === 'string' ? Buffer.byteLength(d) : d.byteLength }));
      return [...texts, ...docs];
    }
    const sized = (folder: string, prefix: string, keep: (n: string) => boolean): Array<{ name: string; size: number }> => {
      try {
        return readdirSync(folder, { withFileTypes: true }).flatMap((e) => {
          if (!e.isFile() || !keep(e.name)) return [];
          try {
            return [{ name: `${prefix}${e.name}`, size: statSync(path.join(folder, e.name)).size }];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    };
    return [...sized(dir, '', shown), ...sized(path.join(dir, FILES_DIR), `${FILES_DIR}/`, (n) => safeFileName(n) === n)];
  }

  /** A listed file's bytes (`report.md`, `step-<n>.txt`, `files/<name>`); none for anything else. */
  readListed(runId: string, name: string): Uint8Array | undefined {
    if (name.startsWith(`${FILES_DIR}/`)) return this.readDocument(runId, name.slice(FILES_DIR.length + 1));
    if (name !== 'report.md' && !/^step-\d+\.txt$/.test(name)) return undefined;
    const text = this.read(runId, name);
    return text === undefined ? undefined : new TextEncoder().encode(text);
  }

  /** Where a listed file is on this Mac (none in memory). */
  listedPath(runId: string, name: string): string | undefined {
    if (name.startsWith(`${FILES_DIR}/`)) return this.documentPath(runId, name.slice(FILES_DIR.length + 1));
    return name === 'report.md' || /^step-\d+\.txt$/.test(name) ? this.pathOf(runId, name) : undefined;
  }

  /** Where a run's document is (none in memory, or a name that isn't one). */
  documentPath(runId: string, name: string): string | undefined {
    const dir = this.folder(runId);
    const safe = safeFileName(name);
    return dir && safe === name ? path.join(dir, FILES_DIR, safe) : undefined;
  }

  /** A document a typed column kept (files/<name>, readable only by you) → whether it was kept. */
  writeDocument(runId: string, name: string, data: string | Uint8Array): boolean {
    if (safeFileName(name) !== name) return false;
    const dir = this.folder(runId);
    if (!dir) {
      const files = this.documents.get(runId) ?? new Map<string, string | Uint8Array>();
      files.set(name, data);
      this.documents.set(runId, files);
      return true;
    }
    try {
      mkdirSync(path.join(dir, FILES_DIR), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, FILES_DIR, name), data, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /** A run's document, as bytes (none: gone, swept, or never kept). */
  readDocument(runId: string, name: string): Uint8Array | undefined {
    if (safeFileName(name) !== name) return undefined;
    const dir = this.folder(runId);
    if (!dir) {
      const v = this.documents.get(runId)?.get(name);
      return v === undefined ? undefined : typeof v === 'string' ? new TextEncoder().encode(v) : v;
    }
    try {
      const file = path.join(dir, FILES_DIR, name);
      if (statSync(file).size > 64 * 1024 * 1024) return undefined;
      return readFileSync(file);
    } catch {
      return undefined;
    }
  }

  /** Whether a run kept documents (they're there to sweep). */
  hasDocuments(runId: string): boolean {
    const dir = this.folder(runId);
    if (!dir) return Boolean(this.documents.get(runId)?.size);
    return existsSync(path.join(dir, FILES_DIR));
  }

  /** A run's documents go (their days are up); the rest of its folder stays. */
  removeDocuments(runId: string): void {
    this.documents.delete(runId);
    const dir = this.folder(runId);
    if (!dir) return;
    try {
      rmSync(path.join(dir, FILES_DIR), { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }

  remove(runId: string): void {
    this.memory.delete(runId);
    this.documents.delete(runId);
    const dir = this.folder(runId);
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}
