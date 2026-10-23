import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistorySaver } from '../src/core/history-saver.js';
import type { LogItem } from '../src/core/store.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

const say = (channel: string, text: string, id = `${channel}-${text}`): LogItem => ({ id, type: 'system', channel, text, ts: 0, level: 'info' });
const idOf = (c: string): string | undefined => (c.startsWith('ws:') ? c.slice(3) : undefined);

function setup(opts: { channels?: string[]; slow?: boolean } = {}) {
  let log: readonly LogItem[] = [];
  const channels = new Set(opts.channels ?? ['ws:a', 'ws:b', 'ws:c']);
  const writes: Array<{ id: string; texts: string[] }> = [];
  const sync: Array<{ id: string; texts: string[] }> = [];
  let inFlight = 0;
  let most = 0;
  const releases: Array<() => void> = [];
  const saver = new HistorySaver({
    log: () => log,
    channels: () => channels,
    idOf,
    write: async (id, items) => {
      most = Math.max(most, ++inFlight);
      if (opts.slow) await new Promise<void>((r) => releases.push(r));
      else await Promise.resolve();
      inFlight--;
      writes.push({ id, texts: items.map((i) => (i as { text: string }).text) });
    },
    writeSync: (id, items) => void sync.push({ id, texts: items.map((i) => (i as { text: string }).text) }),
  });
  const add = (...items: LogItem[]): void => {
    log = [...log, ...items];
    saver.changed();
  };
  const replace = (id: string, text: string): void => {
    log = log.map((l) => (l.id === id ? { ...l, text } : l));
    saver.changed();
  };
  return { saver, add, replace, writes, sync, channels, most: () => most, release: () => releases.splice(0).forEach((r) => r()) };
}

describe('saving workspace conversations', () => {
  afterEach(() => vi.useRealTimers());

  it('writes only the conversations that changed', async () => {
    const t = setup();
    t.add(say('ws:a', 'one'), say('ws:b', 'two'), say('room', 'not a workspace'));
    await t.saver.save();
    expect(t.writes.map((w) => w.id).sort()).toEqual(['a', 'b']);
    t.writes.length = 0;
    // Nothing changed: nothing written.
    await t.saver.save();
    expect(t.writes).toEqual([]);
    // One item added in b, one replaced (streamed) in a: those two, c never.
    t.add(say('ws:b', 'three'));
    await t.saver.save();
    expect(t.writes).toEqual([{ id: 'b', texts: ['two', 'three'] }]);
    t.writes.length = 0;
    t.replace('ws:a-one', 'one, edited');
    t.add(say('room', 'chatter'));
    await t.saver.save();
    expect(t.writes).toEqual([{ id: 'a', texts: ['one, edited'] }]);
  });

  it('keeps the last 500 of a conversation, and leaves conversations not loaded alone', async () => {
    const t = setup({ channels: ['ws:a'] });
    t.add(...Array.from({ length: 520 }, (_, i) => say('ws:a', `m${i}`)), say('ws:b', 'not loaded'));
    await t.saver.save();
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0]!.texts).toHaveLength(500);
    expect(t.writes[0]!.texts[0]).toBe('m20');
  });

  it('waits for a quiet moment, but constant streaming still saves at least every 2 s', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.add(say('ws:a', 'start'));
    await vi.advanceTimersByTimeAsync(399);
    expect(t.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.writes).toHaveLength(1);
    t.writes.length = 0;
    // A change every 100 ms for 6 s: never quiet for 400 ms, yet saved every 2 s.
    for (let i = 0; i < 60; i++) {
      t.replace('ws:a-start', `streamed ${i}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(t.writes.length).toBeGreaterThanOrEqual(3);
    expect(t.writes.length).toBeLessThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(400);
    expect(t.writes.at(-1)!.texts).toEqual(['streamed 59']);
  });

  it('never has two saves going at once: changes meanwhile are saved after it', async () => {
    const t = setup({ slow: true });
    t.add(say('ws:a', 'one'));
    const first = t.saver.save();
    t.add(say('ws:a', 'two'));
    void t.saver.save();
    void t.saver.save();
    expect(t.most()).toBe(1);
    t.release();
    await first;
    expect(t.writes).toEqual([{ id: 'a', texts: ['one'] }]);
    expect(t.saver.pending).toBe(true); // the one asked for meanwhile
    const second = t.saver.save();
    t.release();
    await second;
    expect(t.most()).toBe(1);
    expect(t.writes.at(-1)).toEqual({ id: 'a', texts: ['one', 'two'] });
  });

  it('flush writes what changed now, synchronously', () => {
    const t = setup();
    t.add(say('ws:c', 'before the fork'));
    t.saver.flush();
    expect(t.sync).toEqual([{ id: 'c', texts: ['before the fork'] }]);
    expect(t.saver.pending).toBe(false);
    t.saver.flush();
    expect(t.sync).toHaveLength(1);
  });

  it('an older async write never replaces a newer one on disk', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'klaud-history-'));
    try {
      const store = new WorkspaceStore(home);
      let log: readonly LogItem[] = [say('ws:a', 'old')];
      const saver = new HistorySaver({ log: () => log, channels: () => new Set(['ws:a']), idOf, write: (id, items, current) => store.saveHistoryAsync(id, items, current), writeSync: (id, items) => store.saveHistory(id, items) });
      const slow = saver.save(); // in flight
      log = [say('ws:a', 'new')];
      saver.flush(); // newer, written at once
      await slow;
      expect(store.loadHistory<LogItem>('a').map((l) => (l as { text: string }).text)).toEqual(['new']);
      // No temporary files left behind.
      expect(readdirSync(path.join(home, 'history'))).toEqual(['a.json']);
      expect(JSON.parse(readFileSync(store.historyFile('a'), 'utf8'))).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
