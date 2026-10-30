import { describe, expect, it, vi } from 'vitest';
import { CODEX_CAPABILITIES } from '../src/agent/runtime/codex/index.js';
import { CODEX_USAGE_AGENT } from '../src/agent/runtime/codex/rate-limits.js';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import { routedBackend } from '../src/agent/runtime/router.js';
import type { AgentBackend, AgentRunInput, RoomBridge } from '../src/agent/types.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

const input = (prompt: string): AgentRunInput => ({ prompt, requesterName: 'kay', viaAgent: false, context: [], scope: 'full', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true });

function recording(): { bridge: RoomBridge; reports: Array<[unknown, unknown]> } {
  const reports: Array<[unknown, unknown]> = [];
  return { bridge: { ...room, reportUsage: (u, agent) => void reports.push([u, agent]) }, reports };
}

describe("Codex's plan windows, live (BLG-474)", () => {
  it('says it has usage', () => {
    expect(CODEX_CAPABILITIES.hasUsage).toBe(true);
  });

  it('a run reports where the windows stand, then each account/rateLimits/updated, all under Codex', async () => {
    const { bridge, reports } = recording();
    const codex = new FakeCodex();
    await createCodexBackend({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge, connect: codex.connect }).run(input('hello'));
    await vi.waitFor(() => expect(reports.length).toBeGreaterThanOrEqual(2));
    for (const [, agent] of reports) expect(agent).toEqual(CODEX_USAGE_AGENT);
    expect(reports).toContainEqual([{ fiveHour: { pct: 11, resetsAt: 1780409235000 }, week: { pct: 5, resetsAt: 1780862132000 }, plan: 'plus', signedIn: true }, CODEX_USAGE_AGENT]);
    expect(reports).toContainEqual([{ fiveHour: { pct: 12, resetsAt: 1780409235000 }, week: { pct: 5, resetsAt: 1780862132000 }, plan: 'plus', signedIn: true }, CODEX_USAGE_AGENT]);
  });

  it('refreshUsage (the usage tab, no run) reports for Codex and hands nothing back to be filed as Claude’s', async () => {
    const { bridge, reports } = recording();
    const backend = createCodexBackend({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge, connect: new FakeCodex().connect });
    expect(await backend.refreshUsage!()).toBeUndefined();
    expect(reports).toEqual([[{ fiveHour: { pct: 11, resetsAt: 1780409235000 }, week: { pct: 5, resetsAt: 1780862132000 }, plan: 'plus', signedIn: true }, CODEX_USAGE_AGENT]]);
  });

  it('signed out: nothing is reported (no made-up windows)', async () => {
    const { bridge, reports } = recording();
    const codex = new FakeCodex();
    codex.signedIn = false;
    await createCodexBackend({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge, connect: codex.connect }).refreshUsage!();
    expect(reports).toEqual([]);
  });

  it("the session's usage refresh reaches Codex too, while Claude's comes back as before", async () => {
    const claude: AgentBackend = { run: async () => '', refreshUsage: vi.fn(async () => ({ plan: 'max', updatedAt: 1 })) };
    const codexRefresh = vi.fn(async () => undefined);
    const routed = routedBackend(claude, 'claude', (id) => (id === 'codex' ? { run: async () => '', refreshUsage: codexRefresh } : undefined), ['codex']);
    expect(await routed.refreshUsage!()).toEqual({ plan: 'max', updatedAt: 1 });
    expect(codexRefresh).toHaveBeenCalledOnce();
  });
});
