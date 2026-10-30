import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, prefsFrom } from '../src/core/store.js';
import { clampParallelRuns, slotWaitDetail } from '../src/shared/run-slots.js';
import { Settings } from '../src/shared/settings-schema.js';

describe('conversations at once', () => {
  it('defaults to 10, roomy enough that few people meet it', () => {
    expect(DEFAULT_PREFS.parallelRuns).toBe(10);
    expect(Settings.parse({}).parallelRuns).toBe(10);
    expect(Settings.parse({ parallelRuns: 900 }).parallelRuns).toBe(10);
    expect(prefsFrom(Settings.parse({ parallelRuns: 3 })).parallelRuns).toBe(3);
    expect(clampParallelRuns(undefined)).toBe(10);
    expect(clampParallelRuns(0)).toBe(1);
  });

  it('says in plain words why a message waits', () => {
    expect(slotWaitDetail({ running: 10, limit: 10 })).toBe('Your agent is working in 10 other conversations, your limit at once. This one starts as soon as one of them finishes.');
    expect(slotWaitDetail({ running: 1, limit: 1 })).toContain('1 other conversation,');
  });
});
