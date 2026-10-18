import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { USAGE_DAYS_KEPT, addDay, dailyTotals, dayKey, tokensOf } from '../src/workspaces/usage-days.js';
import { WorkspaceManager } from '../src/workspaces/manager.js';
import { WorkspaceStore } from '../src/workspaces/store.js';

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

describe('usage by day', () => {
  it('keys a moment by its local day', () => {
    expect(dayKey(at(2026, 3, 7, 0))).toBe('2026-03-07');
    expect(dayKey(at(2026, 12, 31, 23))).toBe('2026-12-31');
  });

  it('adds to a day without changing the old record, and keeps only the last days', () => {
    const before = { '2026-10-17': { tokens: 10, cost: 0.1 } };
    const after = addDay(before, '2026-10-17', { tokens: 5, cost: 0.05 });
    expect(after['2026-10-17']).toEqual({ tokens: 15, cost: 0.15000000000000002 });
    expect(before['2026-10-17']).toEqual({ tokens: 10, cost: 0.1 });
    let many: Record<string, { tokens: number; cost: number }> | undefined;
    for (let d = 1; d <= USAGE_DAYS_KEPT + 5; d++) many = addDay(many, dayKey(at(2026, 1, d)), { tokens: d, cost: 0 });
    const keys = Object.keys(many!).sort();
    expect(keys).toHaveLength(USAGE_DAYS_KEPT);
    expect(keys[0]).toBe(dayKey(at(2026, 1, 6)));
  });

  it('counts the tokens a run made (cache reads are nearly free, so they are left out)', () => {
    const run = { input: 100, output: 20, cacheWrite: 5, cacheRead: 9000 };
    expect(tokensOf(run)).toBe(125);
    expect(tokensOf(undefined)).toBe(0);
  });

  it('totals every workspace per day, oldest first, with empty days as zero', () => {
    const now = at(2026, 10, 18);
    const a = { days: { '2026-10-18': { tokens: 100, cost: 1 }, '2026-10-16': { tokens: 40, cost: 0.4 }, '2026-09-01': { tokens: 999, cost: 9 } } };
    const b = { days: { '2026-10-18': { tokens: 50, cost: 0.5 } } };
    const days = dailyTotals([a, b, undefined, {}], now, 3);
    expect(days.map((d) => d.key)).toEqual(['2026-10-16', '2026-10-17', '2026-10-18']);
    expect(days.map((d) => d.tokens)).toEqual([40, 0, 150]);
    expect(days[2]?.cost).toBe(1.5);
    expect(days[0]?.date).toBe(new Date(2026, 9, 16).getTime());
  });
});

describe('WorkspaceManager.addUsage', () => {
  it('remembers what each day added and when Claude last worked there', async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'klaud-usage-days-')));
    const store = new WorkspaceStore(path.join(base, 'home'));
    store.saveConfig({ roots: [], projects: [], hidden: [] });
    const mgr = new WorkspaceManager(store);
    await mgr.refresh();
    const chat = await mgr.createChat('chats', 'ideas');
    const yesterday = at(2026, 10, 17);
    const today = at(2026, 10, 18);
    mgr.addUsage(chat.id, { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300, cost: 0.05, session: 's1' }, yesterday);
    // The same conversation reports a running total: only the growth counts, on the day it happened.
    const u = mgr.addUsage(chat.id, { input: 1500, output: 300, cacheRead: 6000, cacheWrite: 300, cost: 0.08, session: 's1' }, today);
    expect(u?.days).toEqual({ '2026-10-17': { tokens: 1500, cost: 0.05 }, '2026-10-18': { tokens: 600, cost: expect.closeTo(0.03, 6) } });
    expect(u?.lastAt).toBe(today);
    expect(u).toMatchObject({ input: 1500, output: 300, runs: 2 });
  });
});
