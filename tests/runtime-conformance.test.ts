import { describe, expect, it, vi } from 'vitest';
import { claudeRuntime } from '../src/agent/runtime/claude/index.js';
import { createCodexRuntime } from '../src/agent/runtime/codex/index.js';
import type { AgentRuntime, RuntimeCapabilities } from '../src/agent/runtime/types.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { FakeClaude } from './fake-claude.js';
import { FakeCodex } from './fake-codex.js';
import { createFakeRuntime } from './fake-runtime.js';
import { conformanceFailures, runtimeConformance } from './runtime-conformance.js';

// Claude Code behind a scripted Agent SDK `query` (fake-claude.ts): the real runner, hooks and all.
const claude = vi.hoisted(() => ({ query: undefined as unknown as (args: unknown) => unknown }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...(await original<object>()), query: (args: unknown) => claude.query(args) }));
claude.query = new FakeClaude().query as (args: unknown) => unknown;

// The same suite for every runtime: the in-memory reference, Claude through its SDK, and Codex over
// a scripted app-server. Live runs (a signed-in Claude Code or Codex) are waived (BLG-475).
runtimeConformance('fake', createFakeRuntime);
runtimeConformance('claude', () => claudeRuntime);
const codex = new FakeCodex();
runtimeConformance('codex', () => createCodexRuntime({ connect: codex.connect }));

/** The fake runtime, changed: its capabilities patched, and its runs' inputs or answers bent. */
function mutant(caps: Partial<RuntimeCapabilities>, bend: { input?: (i: AgentRunInput) => AgentRunInput; answer?: (a: string) => string } = {}): () => AgentRuntime {
  return () => {
    const rt = createFakeRuntime();
    return {
      ...rt,
      capabilities: { ...rt.capabilities, ...caps },
      create: (opts) => {
        const b = rt.create(opts);
        return { ...b, run: async (i: AgentRunInput) => (bend.answer ?? ((a) => a))(await b.run(bend.input ? bend.input(i) : i)) };
      },
    };
  };
}

describe('the conformance suite catches what no capability flag covers', () => {
  it('passes the reference runtime as it is', async () => {
    expect(await conformanceFailures(createFakeRuntime)).toEqual([]);
  });

  it.each([
    ['answers in other words', mutant({}, { answer: (a) => `${a}.` })],
    ['runs a command without asking', mutant({}, { input: (i) => ({ ...i, canUseTool: async () => true }) })],
    ['says it steers, but takes nothing in', mutant({ canSteer: true })],
    ['says it has no usage, but reports some', mutant({}, { input: (i) => ({ ...i, onEvent: (k, t) => (i.onEvent(k, t), k === 'text' && i.onEvent('usage', '{}')) }) })],
    ['says it has usage, but reports none', mutant({ hasUsage: true })],
    ["says it can't list models, but does", mutant({ hasModelList: false })],
    ['forgets the conversation it says it resumes', mutant({}, { input: (i) => (i.place ? { ...i, place: { ...i.place, resume: undefined } } : i) })],
  ])('fails a runtime that %s', async (_, make) => {
    expect((await conformanceFailures(make)).length).toBeGreaterThan(0);
  });
});
