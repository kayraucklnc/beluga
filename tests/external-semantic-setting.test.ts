import { describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/core/store.js';
import { EXTERNAL_ACCESS } from '../src/external/coverage.js';
import { callTool } from '../src/external/adapters/mcp-tools.js';
import { GATED_ROWS } from '../src/external/adapters/tools/gated.js';
import { methodTools } from '../src/external/adapters/tools/method-tool.js';
import type { Grant } from '../src/external/domain/grant.js';
import type { Level } from '../src/external/domain/decide.js';
import type { MethodCalls } from '../src/external/ports/methods.js';
import { EXPERIMENT_INFO, EXPERIMENTS, experimentOn, withExperiment } from '../src/shared/experiments.js';

const grant = (level: Level): Grant => ({ id: 'g1', name: 'GrokBot', clientId: 'c', redirectHost: 'h', route: 'local', level, projects: 'all', chats: { dms: false, groups: false }, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0 });

describe('the setting', () => {
  it('is the experiment Semantic tool search, off by default, saying what it fetches and where its data stays', () => {
    expect(EXPERIMENTS).toContain('toolSearch');
    expect(experimentOn(initialState('room', 'ask').prefs.experiments, 'toolSearch')).toBe(false);
    const info = EXPERIMENT_INFO.toolSearch;
    expect(info.title).toBe('Semantic tool search');
    expect(info.cost).toMatch(/4 MB/);
    expect(info.cost).toMatch(/134 MB/);
    expect(info.cost).toMatch(/minute/);
    expect(info.cost).toMatch(/this computer/);
  });
});

describe('an agent cannot turn it on with no card', () => {
  const setup = (answer: 'yes' | 'no') => {
    const call = vi.fn();
    const calls = { call, personName: (p: string) => p } as unknown as MethodCalls;
    const tool = methodTools(GATED_ROWS, {} as never, calls, () => undefined).find((t) => t.name === 'session_set_prefs')!;
    const cards: Array<{ title: string; once: boolean }> = [];
    const deps = { audit: { append: () => undefined } as never, ask: async (title: string, _d: string, once: boolean) => (cards.push({ title, once }), answer), now: Date.now, always: new Set<string>(), live: () => true, cards: new Map() };
    const turnOn = (level: Level) => callTool(tool, { patch: { experiments: withExperiment([], 'toolSearch', true) } }, grant(level), deps);
    return { call, cards, turnOn };
  };

  it('session.setPrefs is gated for agents', () => {
    expect(EXTERNAL_ACCESS['session.setPrefs']).toBe('gated');
  });

  it('at every level, a card first; a no leaves it off', async () => {
    for (const level of ['ask', 'trusted', 'full'] as const) {
      const f = setup('no');
      await f.turnOn(level);
      expect(f.cards).toHaveLength(1);
      expect(f.call).not.toHaveBeenCalled();
    }
  });

  it('a person\'s yes on the card turns it on, and only once', async () => {
    const f = setup('yes');
    await f.turnOn('full');
    expect(f.cards).toEqual([{ title: expect.stringContaining('toolSearch'), once: true }]);
    expect(f.call).toHaveBeenCalledWith('session.setPrefs', [{ experiments: ['toolSearch'] }]);
    await f.turnOn('full');
    expect(f.cards).toHaveLength(2);
  });
});
