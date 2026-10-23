import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type StepPage, type StepRecord, sizeOf, summaryOf } from '../shared/steps.js';

/**
 * Where the details of Claude's steps live (see shared/steps.ts): beside the chat, never in it.
 * The chat item keeps its one-line steps as before; this keeps, per run, every step's record
 * (input, output, thinking), in memory for recent runs and on disk (bounded) so a card can be
 * opened again after Beluga restarts. Only ever read by screens on this computer
 * (`agent.steps`, `agent.step`); nothing here is sent to anyone.
 */

/** Steps kept per run (the oldest drop off). */
export const MAX_RUN_STEPS = 500;
/** Characters of details kept per run; past it the oldest steps lose their details (not their line). */
export const MAX_RUN_CHARS = 3_000_000;
/** Runs kept in memory. */
const MEMORY_RUNS = 40;
/** Runs kept on disk (the oldest files go). */
const DISK_RUNS = 300;
/** A run's file is written this long after its last change (and right away when it ends). */
const SAVE_DELAY_MS = 2_000;

interface Run {
  readonly key: string;
  readonly order: string[];
  readonly records: Map<string, StepRecord>;
  chars: number;
  version: number;
  timer?: NodeJS.Timeout;
}

const fileName = (key: string): string => `${createHash('sha1').update(key).digest('hex')}.json`;

export class StepBook {
  private readonly runs = new Map<string, Run>();

  /** `dir`: where runs are saved (none: memory only). */
  constructor(private readonly dir?: string) {}

  /** Add a step or replace it with a newer version of itself. */
  put(key: string, record: StepRecord): void {
    const run = this.run(key, true)!;
    const old = run.records.get(record.id);
    if (old) run.chars -= sizeOf(old);
    else run.order.push(record.id);
    run.records.set(record.id, record);
    run.chars += sizeOf(record);
    this.trim(run);
    run.version++;
    this.scheduleSave(run);
  }

  /** Replace a run's steps (a conversation imported from Claude Code). */
  putAll(key: string, records: readonly StepRecord[]): void {
    const run = this.run(key, true)!;
    run.order.splice(0);
    run.records.clear();
    run.chars = 0;
    for (const r of records) {
      run.order.push(r.id);
      run.records.set(r.id, r);
      run.chars += sizeOf(r);
    }
    this.trim(run);
    run.version++;
    this.scheduleSave(run);
  }

  has(key: string): boolean {
    return Boolean(this.run(key, false));
  }

  /** The run's steps, light. `after`: the version you have (unchanged: nothing is sent again). */
  page(key: string, after?: number): StepPage {
    const run = this.run(key, false);
    if (!run) return { steps: [], version: 0, missing: true };
    if (after !== undefined && after === run.version) return { steps: [], version: run.version, unchanged: true };
    return { steps: run.order.map((id) => summaryOf(run.records.get(id)!)), version: run.version };
  }

  /** One step with its details. */
  get(key: string, stepId: string): StepRecord | undefined {
    return this.run(key, false)?.records.get(stepId);
  }

  /** Write a run now (it ended). */
  flush(key: string): void {
    const run = this.runs.get(key);
    if (!run) return;
    clearTimeout(run.timer);
    run.timer = undefined;
    this.save(run);
  }

  /** Write everything waiting (Beluga is quitting). */
  flushAll(): void {
    for (const key of this.runs.keys()) this.flush(key);
  }

  private run(key: string, create: boolean): Run | undefined {
    let run = this.runs.get(key) ?? this.load(key);
    if (!run && create) run = { key, order: [], records: new Map(), chars: 0, version: 0 };
    if (!run) return undefined;
    // Most recently used last: the first one is the one to forget.
    this.runs.delete(key);
    this.runs.set(key, run);
    while (this.runs.size > MEMORY_RUNS) {
      const [oldest] = this.runs.values();
      if (!oldest) break;
      this.flush(oldest.key);
      this.runs.delete(oldest.key);
    }
    return run;
  }

  private trim(run: Run): void {
    while (run.order.length > MAX_RUN_STEPS) {
      const id = run.order.shift()!;
      run.chars -= sizeOf(run.records.get(id)!);
      run.records.delete(id);
    }
    // Too much detail: the oldest steps keep their line, not their input and output.
    for (const id of run.order) {
      if (run.chars <= MAX_RUN_CHARS) break;
      const r = run.records.get(id)!;
      if (r.output === undefined && r.input === undefined && r.text === undefined) continue;
      const light = { ...summaryOf(r), truncated: true, ...(r.isError ? { isError: true } : {}) };
      run.chars += sizeOf(light) - sizeOf(r);
      run.records.set(id, light);
    }
  }

  private scheduleSave(run: Run): void {
    if (!this.dir || run.timer) return;
    run.timer = setTimeout(() => {
      run.timer = undefined;
      this.save(run);
    }, SAVE_DELAY_MS);
    run.timer.unref?.();
  }

  private save(run: Run): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = path.join(this.dir, fileName(run.key));
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ key: run.key, version: run.version, steps: run.order.map((id) => run.records.get(id)) }), { mode: 0o600 });
      renameSync(tmp, file);
      this.prune();
    } catch {
      // Details are a nicety: a full disk must not stop Claude.
    }
  }

  private load(key: string): Run | undefined {
    if (!this.dir) return undefined;
    try {
      const data = JSON.parse(readFileSync(path.join(this.dir, fileName(key)), 'utf8')) as { key?: string; version?: number; steps?: StepRecord[] };
      if (data.key !== key || !Array.isArray(data.steps)) return undefined;
      const steps = data.steps.filter((r): r is StepRecord => Boolean(r && typeof r.id === 'string' && typeof r.title === 'string'));
      return { key, order: steps.map((r) => r.id), records: new Map(steps.map((r) => [r.id, r])), chars: steps.reduce((n, r) => n + sizeOf(r), 0), version: data.version ?? 1 };
    } catch {
      return undefined;
    }
  }

  private prune(): void {
    if (!this.dir) return;
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    if (files.length <= DISK_RUNS) return;
    const dated = files.map((f) => ({ f, t: statSync(path.join(this.dir!, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { f } of dated.slice(0, files.length - DISK_RUNS)) {
      try {
        unlinkSync(path.join(this.dir, f));
      } catch {
        // Already gone.
      }
    }
  }
}

/** The book key for a run of your Claude (request ids are unique). */
export const runKey = (requestId: string): string => `run:${requestId}`;
/** The book key for a turn imported from a Claude Code transcript (its id is only unique within that transcript). */
export const importedKey = (sessionId: string, itemId: string): string => `imp:${sessionId}:${itemId}`;
