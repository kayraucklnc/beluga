import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import { AgentHost } from '../src/core/agent-host.js';
import type { Plan } from '../src/core/plans/model.js';
import { headBrief, planningBrief } from '../src/core/plans/prompt.js';
import { PLAN_TOOL_NAMES } from '../src/agent/plan-tools.js';
import { decideTool } from '../src/agent/policy.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

/**
 * BLG-10: the plan's own conversation (its head Claude, the orchestrator) always answers: it never
 * waits for a run slot behind the task runs it started, and it may change things where it runs
 * (it isn't questions-only like other main-folder chats).
 */

const ME = 'me';
const HOME = 'ws:home';

function setup() {
  const store = new Store(initialState('room', 'auto'));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-plan-home-'));
  store.dispatch({ type: 'plans_init', state: { enabled: true, style: '', plans: [{ id: 'pl1', projectId: 'p', home: HOME, status: 'active', runs: {}, activity: [] } as unknown as Plan] } });
  const runs: AgentRunInput[] = [];
  const release: Array<() => void> = [];
  const agent: AgentBackend = {
    async run(input: AgentRunInput) {
      runs.push(input);
      // Task runs work until released; the plan's conversation answers at once.
      if (input.prompt.startsWith('task')) return new Promise<string>((resolve) => release.push(() => resolve('done')));
      return `answered ${input.prompt}`;
    },
  };
  const place = (channel: string) => ({ cwd: dir, additionalDirectories: [], autoEdit: channel !== HOME, onSession: () => undefined, ...(channel === HOME ? { askOnly: { project: 'p' }, fixup: path.join(dir, 'fix') } : {}) });
  const host = new AgentHost({
    store,
    selfId: () => ME,
    send: () => true,
    agent: () => agent,
    shares: {} as never,
    sharing: { recipients: () => [], sharedFor: () => undefined, canPost: () => true } as never,
    people: {} as never,
    questions: { track: () => undefined, ask: async () => ({ kind: 'skip' }), cancelAll: () => undefined, cancelChannel: () => undefined } as never,
    toast: () => undefined,
    system: () => undefined,
    approvalTimeoutMs: () => 60_000,
    refreshUsage: async () => undefined,
    workspaces: { place, refreshWorkspace: async () => undefined, manager: { list: [] } } as never,
    plans: (channel) => (channel === HOME ? { tools: {} as never, brief: 'head' } : undefined),
  });
  const ask = (requestId: string, prompt: string, channel: string): Promise<void> => host.onAgentRequest(ME, { kind: 'agent_request', requestId, prompt, viaAgent: false, channel, urgent: false, plan: false });
  return { host, runs, release, ask };
}

describe('the plan’s own conversation', () => {
  it('answers while four task runs take every slot', async () => {
    const t = setup();
    for (let i = 1; i <= 4; i++) await t.ask(`t${i}`, `task ${i}`, `ws:w${i}`);
    await waitFor(() => t.runs.length === 4);
    // A fifth task waits for a slot…
    await t.ask('t5', 'task 5', 'ws:w5');
    // …but you, talking to the plan, don't.
    await t.ask('h1', 'stop the API task', HOME);
    await waitFor(() => t.runs.some((r) => r.prompt === 'stop the API task'));
    expect(t.runs.some((r) => r.prompt === 'task 5')).toBe(false);
    t.release.forEach((r) => r());
    await waitFor(() => t.runs.some((r) => r.prompt === 'task 5'));
  });

  it('isn’t questions-only: its Claude may change things (and still fixes conflicts in a hidden worktree)', async () => {
    const t = setup();
    await t.ask('h1', 'write the notes', HOME);
    await waitFor(() => t.runs.length === 1);
    expect(t.runs[0]!.place?.askOnly).toBeUndefined();
    expect(t.runs[0]!.place?.fixup).toMatch(/fix$/);
    expect(t.runs[0]!.planBrief).toBe('head');
  });
});

describe('what the plan’s Claude is told it is', () => {
  it('the orchestrator of the whole plan, with tools to stop, start, redirect and pause', () => {
    const plan = { id: 'pl1', projectId: 'p', home: HOME, status: 'active', runs: {}, activity: [], autonomy: 'gated', maxParallel: 3, testsAt: 'milestone', body: { title: 'Payments', goal: '', milestones: [] } } as unknown as Plan;
    const head = headBrief({ plan, milestones: [], open: [], ready: [], active: [], next: { kind: 'done' }, done: 0, total: 0 } as never);
    expect(head).toContain('orchestrator of the whole plan');
    expect(head).toContain('plan_stop_task');
    expect(head).toContain('plan_pause');
    const planning = planningBrief(plan, { enabled: true, issues: [], projects: {} } as never, '');
    expect(planning).not.toMatch(/read-only/);
    expect(planning).toContain('`decision`');
    for (const name of ['mcp__beluga_plan__plan_stop_task', 'mcp__beluga_plan__plan_pause']) {
      expect(PLAN_TOOL_NAMES).toContain(name);
      expect(decideTool(name, {}, { cwd: '/tmp', roots: ['/tmp'], autoEdit: false })).toBe('allow');
    }
  });
});
