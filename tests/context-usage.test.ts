import { describe, expect, it } from 'vitest';
import {
  AUTO_COMPACT_DEFAULT,
  COMPACT_INSTRUCTIONS,
  autoCompactDue,
  breakdownFrom,
  clampThreshold,
  compactEnv,
  contextPct,
  contextTokens,
  contextTone,
  contextWindowFor,
  formatTokenCount,
  windowOfRun,
} from '../src/shared/context-usage.js';
import { Settings } from '../src/shared/settings-schema.js';
import { DEFAULT_PREFS, prefsFrom } from '../src/core/store.js';

describe('context accounting', () => {
  it('counts what the model saw: fresh input plus cache reads and cache writes (not output)', () => {
    expect(contextTokens({ input_tokens: 1_200, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 6_800 })).toBe(98_000);
    expect(contextTokens({ input_tokens: 500 })).toBe(500);
    expect(contextTokens({ input_tokens: null, cache_read_input_tokens: null })).toBe(0);
    expect(contextTokens(undefined)).toBe(0);
  });

  it('knows each model’s window: what Claude Code reported, else 1M for [1m] models, else 200k', () => {
    expect(contextWindowFor('claude-opus-5-5')).toBe(200_000);
    expect(contextWindowFor('claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextWindowFor('sonnet[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-5-1m')).toBe(1_000_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
    expect(contextWindowFor('claude-opus-5-5', 1_000_000)).toBe(1_000_000);
    expect(contextWindowFor('claude-opus-5-5[1m]', 0)).toBe(1_000_000);
  });

  it('takes the main model’s window from a run’s per-model usage (helpers like Haiku are smaller)', () => {
    expect(windowOfRun({ 'claude-haiku-5-5': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 1_000_000 } })).toBe(1_000_000);
    expect(windowOfRun({}, 'opus[1m]')).toBe(1_000_000);
    expect(windowOfRun(undefined)).toBe(200_000);
  });

  it('turns usage into a whole percentage and a tone: neutral, amber at 70, red at 90', () => {
    expect(contextPct({ used: 128_000, window: 200_000 })).toBe(64);
    expect(contextPct({ used: 300_000, window: 200_000 })).toBe(100);
    expect(contextPct({ used: 0, window: 200_000 })).toBe(0);
    expect(contextPct({ used: 10, window: 0 })).toBe(0);
    expect(contextPct(undefined)).toBe(0);
    expect([69, 70, 89, 90, 100].map(contextTone)).toEqual(['normal', 'warn', 'warn', 'full', 'full']);
  });

  it('formats token counts briefly', () => {
    expect(formatTokenCount(940)).toBe('940');
    expect(formatTokenCount(128_400)).toBe('128k');
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(formatTokenCount(-3)).toBe('0');
  });
});

describe('auto-compact threshold', () => {
  it('keeps the threshold within 70–95 and defaults to 85', () => {
    expect(clampThreshold(50)).toBe(70);
    expect(clampThreshold(99)).toBe(95);
    expect(clampThreshold(82.4)).toBe(82);
    expect(clampThreshold(undefined)).toBe(AUTO_COMPACT_DEFAULT);
    expect(clampThreshold(Number.NaN)).toBe(85);
  });

  it('is due at or past the threshold, only when on, not while compacting, and once per run', () => {
    const info = (pct: number) => ({ used: pct * 2_000, window: 200_000 });
    expect(autoCompactDue({ on: true, at: 85, info: info(85) })).toBe(true);
    expect(autoCompactDue({ on: true, at: 85, info: info(84) })).toBe(false);
    expect(autoCompactDue({ on: false, at: 85, info: info(99) })).toBe(false);
    expect(autoCompactDue({ on: true, at: 85 })).toBe(false);
    expect(autoCompactDue({ on: true, at: 85, info: { ...info(95), compacting: true } })).toBe(false);
    expect(autoCompactDue({ on: true, at: 85, info: info(95), triedSinceRun: true })).toBe(false);
    // A threshold outside the range counts as its nearest end.
    expect(autoCompactDue({ on: true, at: 10, info: info(71) })).toBe(true);
  });

  it('tells Claude Code’s own auto-compact the same threshold (nothing when off)', () => {
    expect(compactEnv(true, 80)).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' });
    expect(compactEnv(true, 120)).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '95' });
    expect(compactEnv(false, 80)).toEqual({});
  });

  it('is a saved setting: on at 85% by default, a bad saved value falls back to 85', () => {
    expect(DEFAULT_PREFS).toMatchObject({ autoCompact: true, autoCompactAt: 85 });
    expect(Settings.parse({})).toMatchObject({ autoCompact: true, autoCompactAt: 85 });
    expect(Settings.parse({ autoCompactAt: 400 }).autoCompactAt).toBe(85);
    expect(prefsFrom(Settings.parse({ autoCompact: false, autoCompactAt: 72 }))).toMatchObject({ autoCompact: false, autoCompactAt: 72 });
  });

  it('asks Claude to keep decisions, open tasks and file paths', () => {
    expect(COMPACT_INSTRUCTIONS).toMatch(/decision/);
    expect(COMPACT_INSTRUCTIONS).toMatch(/open tasks/);
    expect(COMPACT_INSTRUCTIONS).toMatch(/paths/);
  });
});

describe('context breakdown', () => {
  const report = {
    categories: [
      { name: 'System prompt', tokens: 3_000, kind: 'used' },
      { name: 'System tools', tokens: 12_000, kind: 'used' },
      { name: 'Memory files', tokens: 5_000, kind: 'used' },
      { name: 'Messages', tokens: 80_000, kind: 'used' },
      { name: 'Free space', tokens: 80_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 20_000, kind: 'buffer' },
      { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
    ],
    messageBreakdown: { toolCallTokens: 6_000, toolResultTokens: 30_000 },
  };

  it('splits into conversation, tool results and system & files, scaled to what the model saw', () => {
    expect(breakdownFrom(report, 100_000)).toEqual({ conversation: 44_000, tools: 36_000, system: 20_000 });
    const scaled = breakdownFrom(report, 50_000)!;
    expect(scaled.conversation + scaled.tools + scaled.system).toBe(50_000);
  });

  it('says nothing when Claude Code reported nothing usable', () => {
    expect(breakdownFrom(undefined, 1000)).toBeUndefined();
    expect(breakdownFrom({ categories: [{ name: 'Free space', tokens: 10, kind: 'free' }] }, 1000)).toBeUndefined();
    expect(breakdownFrom({ categories: [{ name: 'Messages', tokens: 900 }], messageBreakdown: { toolResultTokens: 5_000 } }, 0)).toEqual({ conversation: 0, tools: 900, system: 0 });
  });
});
