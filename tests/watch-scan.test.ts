import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeWatcher } from '../src/core/claude-code/watch.js';
import { Store, initialState } from '../src/core/store.js';

const SID = '0f0e0d0c-1111-2222-3333-444444444444';
const line = (text: string): string => `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), sessionId: SID, cwd: '/tmp/somewhere', message: { role: 'user', content: text } })}\n`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Counts scans, and how many ran at the same time. */
function countScans(): { runs: number; most: number } {
  const proto = ClaudeCodeWatcher.prototype as unknown as { scanOnce: () => Promise<void> };
  const original = proto.scanOnce;
  const seen = { runs: 0, most: 0 };
  let running = 0;
  vi.spyOn(proto, 'scanOnce').mockImplementation(async function (this: unknown) {
    seen.runs++;
    seen.most = Math.max(seen.most, ++running);
    try {
      await wait(5);
      await original.call(this);
    } finally {
      running--;
    }
  });
  return seen;
}

describe('the transcript scan', () => {
  let home: string;
  let folder: string;
  let store: Store;
  let w: ClaudeCodeWatcher;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'klaud-scan-'));
    folder = path.join(home, 'projects', '-tmp-somewhere');
    mkdirSync(folder, { recursive: true });
    store = new Store(initialState('room'));
  });
  afterEach(() => {
    w?.stop();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const shown = (): string[] => {
    w.poll();
    w.publish();
    return store.getState().claudeCode.sessions.map((s) => s.id);
  };

  it('asks close together make one scan (debounced)', async () => {
    const seen = countScans();
    w = new ClaudeCodeWatcher({ home, store, watch: false, scanDebounceMs: 30 });
    for (let i = 0; i < 10; i++) w.requestScan();
    expect(seen.runs).toBe(0);
    await wait(80);
    while (w.scanBusy) await wait(5);
    expect(seen.runs).toBe(1);
    w.requestScan();
    await wait(80);
    while (w.scanBusy) await wait(5);
    expect(seen.runs).toBe(2);
  });

  it('never runs two scans at once: one asked for meanwhile runs once after it', async () => {
    const seen = countScans();
    w = new ClaudeCodeWatcher({ home, store, watch: false });
    writeFileSync(path.join(folder, `${SID}.jsonl`), line('hello'));
    const all = [w.scan(), w.scan(), w.scan(), w.scan()];
    await Promise.all(all);
    expect(seen.most).toBe(1);
    expect(seen.runs).toBe(2);
    expect(w.scanBusy).toBe(false);
    expect(shown()).toEqual([SID]);
  });

  it('reads an old transcript’s time again only when its folder changed or on a sweep (incremental)', async () => {
    const file = path.join(folder, `${SID}.jsonl`);
    writeFileSync(file, line('long ago'));
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    utimesSync(file, old, old);
    w = new ClaudeCodeWatcher({ home, store, watch: false, sweepMs: 60 * 60_000 });
    await w.scan();
    expect(shown()).toEqual([]);
    // Written again (the folder's own time doesn't change): not looked at before a sweep...
    appendFileSync(file, line('back again'));
    await w.scan();
    expect(shown()).toEqual([]);
    // ...or until something in its folder changes.
    writeFileSync(path.join(folder, 'other.txt'), 'x');
    const later = new Date(Date.now() + 2000);
    utimesSync(folder, later, later);
    await w.scan();
    expect(shown()).toEqual([SID]);
  });

  it('a sweep reads every transcript’s time again', async () => {
    const file = path.join(folder, `${SID}.jsonl`);
    writeFileSync(file, line('long ago'));
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    utimesSync(file, old, old);
    w = new ClaudeCodeWatcher({ home, store, watch: false, sweepMs: 0 });
    await w.scan();
    expect(shown()).toEqual([]);
    appendFileSync(file, line('back again'));
    await w.scan();
    expect(shown()).toEqual([SID]);
  });

  it('start scans on its own, and stop ends it', async () => {
    writeFileSync(path.join(folder, `${SID}.jsonl`), line('hello'));
    w = new ClaudeCodeWatcher({ home, store, watch: false, publishMs: 0 });
    w.start();
    for (let i = 0; i < 100 && !store.getState().claudeCode.sessions.length; i++) await wait(10);
    expect(store.getState().claudeCode.sessions.map((s) => s.id)).toEqual([SID]);
    w.stop();
    await w.scan();
  });
});
