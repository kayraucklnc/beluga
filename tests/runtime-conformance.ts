import { describe, expect, it, vi } from 'vitest';
import { guardedBackend } from '../src/agent/runtime/guard.js';
import { type AgentRuntime, INTERRUPT_TIMEOUT_MS } from '../src/agent/runtime/types.js';
import type { AgentBackend, AgentPlace, AgentRunInput, FollowUp, RoomBridge, Steer } from '../src/agent/types.js';
import type { StepRecord } from '../src/shared/steps.js';

/**
 * The runtime conformance suite (BLG-453, BLG-462): what every AgentRuntime must do the same way,
 * so the session layer and the screens never need to know which agent ran. A runtime is tested
 * against a scripted agent behind it (the fake runtime is one; Claude's test scripts the Agent
 * SDK's `query`, fake-claude.ts; Codex's its app-server, fake-codex.ts, in the shapes codex-cli
 * sends), which follows this script:
 *
 * - a prompt `P` is answered `echo: P`, after one shell step running `echo P`;
 * - a prompt starting with `ask` runs a command that needs your approval: declined, the step
 *   fails and the answer is `denied: P`;
 * - a prompt starting with `wait` keeps working (a shell step that never ends) until interrupted.
 *
 * The prompt the agent sees is Beluga's built prompt; the script reads its last line as `P`.
 *
 * Where runtimes may differ, a capability flag says so and the scenario checks the flag BOTH ways
 * (one that says it steers must steer; one that says it can't must not), so any difference no flag
 * covers fails a scenario. tests/runtime-conformance.test.ts runs mutants to prove it does.
 */

export const room: RoomBridge = {
  selfName: () => 'kay',
  sendChat: () => undefined,
  listPeers: () => [],
  askAgent: async () => '',
  listPeerFiles: async () => [],
  readPeerFile: async () => '',
  writeReport: async () => '',
  reportUsage: () => undefined,
  getPeerFile: async () => '',
  sendFile: async () => '',
};

export { scriptedWords } from '../src/agent/runtime/codex/scripted.js';

interface Recorded {
  readonly events: Array<[string, string]>;
  readonly steps: StepRecord[];
}

function runInput(prompt: string, extra: Partial<AgentRunInput> = {}): AgentRunInput & Recorded {
  const events: Array<[string, string]> = [];
  const steps: StepRecord[] = [];
  return {
    prompt,
    requesterName: 'kay',
    viaAgent: false,
    context: [],
    scope: 'folder',
    signal: new AbortController().signal,
    onEvent: (kind, text) => void events.push([kind, text]),
    onStep: (r) => void steps.push(r),
    onFileTouched: () => undefined,
    canUseTool: async () => true,
    events,
    steps,
    ...extra,
  };
}

function followUp(prompt: string): FollowUp & { readonly answer: Promise<string> } {
  let onDone!: (t: string) => void;
  let onError!: (t: string) => void;
  const answer = new Promise<string>((res, rej) => ((onDone = res), (onError = (e) => rej(new Error(e)))));
  return { prompt, requesterName: 'kay', viaAgent: false, context: [], onEvent: () => undefined, onDone, onError, answer };
}

const place = (extra: Partial<AgentPlace> = {}): AgentPlace & { sessions: string[] } => {
  const sessions: string[] = [];
  return { cwd: process.cwd(), additionalDirectories: [], autoEdit: true, onSession: (id) => void sessions.push(id), sessions, ...extra };
};

/** Resolves with the steer once the run offers one and a step is running. */
async function steerWhenWorking(steers: Array<Steer | undefined>, input: Recorded): Promise<Steer> {
  await vi.waitFor(() => {
    expect(steers.at(-1)).toBeTypeOf('function');
    expect(input.steps.some((s) => s.status === 'running')).toBe(true);
  }, 5_000);
  return steers.at(-1)!;
}

/** One scenario: throws (an expect failing) when the runtime doesn't behave. */
export interface Scenario {
  readonly name: string;
  readonly run: (make: () => AgentRuntime) => Promise<void>;
}

const backendOf = (make: () => AgentRuntime): AgentBackend => {
  const rt = make();
  return guardedBackend(rt.create({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room }), rt.capabilities);
};

/** The usage events a run sent, parsed. */
const usages = (input: Recorded): Array<Record<string, unknown>> => input.events.filter(([k]) => k === 'usage').map(([, t]) => JSON.parse(t) as Record<string, unknown>);

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'says what it can do',
    run: async (make) => {
      const rt = make();
      expect(rt.id).toMatch(/^[a-z][\w-]*$/);
      expect(rt.label).toBeTruthy();
      for (const [key, value] of Object.entries(rt.capabilities)) if (key !== 'toolMounts' && key !== 'skills') expect(typeof value, key).toBe('boolean');
      expect(['native', 'mapped']).toContain(rt.capabilities.skills);
      expect(rt.capabilities.toolMounts.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'answers a prompt, with its text and its step streamed as they happen',
    run: async (make) => {
      const input = runInput('hello');
      const answered = vi.fn();
      expect(await backendOf(make).run({ ...input, onAnswered: answered })).toBe('echo: hello');
      expect(answered).toHaveBeenCalledWith('echo: hello');
      expect(input.events).toContainEqual(['text', 'echo: hello']);
      expect(input.events.some(([kind]) => kind === 'tool')).toBe(true);
      // One Bash step: running, then done, under one id, in Beluga's own words.
      const bash = input.steps.filter((s) => s.kind === 'tool');
      expect(bash[0]).toMatchObject({ tool: 'Bash', status: 'running', input: { command: 'echo hello' } });
      expect(bash.at(-1)).toMatchObject({ id: bash[0]!.id, tool: 'Bash', status: 'done', label: expect.any(String) });
      expect(bash.at(-1)!.output).toContain('hello');
    },
  },
  {
    name: 'asks you before a command that needs it, and runs it once you approve',
    run: async (make) => {
      const canUseTool = vi.fn(async () => true);
      const input = runInput('ask first', { canUseTool });
      expect(await backendOf(make).run(input)).toBe('echo: ask first');
      expect(canUseTool).toHaveBeenCalledWith('Bash', expect.objectContaining({ command: 'echo ask first' }));
      expect(input.steps.filter((s) => s.kind === 'tool').at(-1)).toMatchObject({ tool: 'Bash', status: 'done' });
    },
  },
  {
    name: "doesn't run a command you decline, and goes on to answer",
    run: async (make) => {
      const canUseTool = vi.fn(async () => false);
      const input = runInput('ask first', { canUseTool });
      expect(await backendOf(make).run(input)).toBe('denied: ask first');
      expect(canUseTool).toHaveBeenCalledWith('Bash', expect.objectContaining({ command: 'echo ask first' }));
      expect(input.steps.filter((s) => s.kind === 'tool').at(-1)).toMatchObject({ tool: 'Bash', status: 'error' });
    },
  },
  {
    name: 'names its conversation once per place: a new one for a new place, the same one resumed',
    run: async (make) => {
      const first = place();
      await backendOf(make).run(runInput('one', { place: first }));
      // Said once, or again with the same id (Claude Code names it as it starts and as it ends).
      expect(new Set(first.sessions).size).toBe(1);
      expect(first.sessions[0]).toEqual(expect.any(String));
      const other = place();
      await backendOf(make).run(runInput('other', { place: other }));
      expect(other.sessions[0]).not.toBe(first.sessions[0]);
      const again = place({ resume: first.sessions[0]! });
      expect(await backendOf(make).run(runInput('two', { place: again }))).toBe('echo: two');
      if (make().capabilities.canResume) expect(new Set(again.sessions)).toEqual(new Set(first.sessions));
      else expect(again.sessions).not.toContain(first.sessions[0]);
    },
  },
  {
    name: 'reports each turn’s usage under its conversation exactly when it says it has usage',
    run: async (make) => {
      const at = place();
      const input = runInput('hello', { place: at });
      await backendOf(make).run(input);
      const used = usages(input);
      if (!make().capabilities.hasUsage) return void expect(used).toEqual([]);
      expect(used.length).toBeGreaterThan(0);
      for (const u of used) expect(u).toMatchObject({ input: expect.any(Number), output: expect.any(Number), cacheRead: expect.any(Number), cacheWrite: expect.any(Number), cost: expect.any(Number), session: at.sessions[0] });
    },
  },
  {
    name: 'takes a message in while it works exactly when it says it steers',
    run: async (make) => {
      const steers: Array<Steer | undefined> = [];
      const abort = new AbortController();
      const input = runInput('wait for it', { signal: abort.signal, onSteer: (s) => void steers.push(s) });
      const running = backendOf(make).run(input);
      void running.catch(() => undefined);
      try {
        const steer = await steerWhenWorking(steers, input);
        const next = followUp('also this');
        void next.answer.catch(() => undefined);
        expect(steer(next)).toBe(make().capabilities.canSteer);
      } finally {
        abort.abort();
        await running.catch(() => undefined);
      }
    },
  },
  {
    name: 'interrupts a running turn within the timeout, and answers the message in the next',
    run: async (make) => {
      const steers: Array<Steer | undefined> = [];
      const abort = new AbortController();
      const input = runInput('wait for it', { signal: abort.signal, onSteer: (s) => void steers.push(s) });
      const running = backendOf(make).run(input);
      void running.catch(() => undefined);
      const steer = await steerWhenWorking(steers, input);
      if (!make().capabilities.canInterrupt) {
        const next = followUp('after');
        void next.answer.catch(() => undefined);
        expect(steer.interrupt ? await steer.interrupt(next, 'Stopped.') : false).toBe(false);
        abort.abort();
        return void (await running.catch(() => undefined));
      }
      const next = followUp('after');
      const started = Date.now();
      expect(await steer.interrupt!(next, 'Stopped for your message.')).toBe(true);
      expect(Date.now() - started).toBeLessThan(INTERRUPT_TIMEOUT_MS);
      expect(await next.answer).toBe('echo: after');
      expect(await running).toContain('Stopped for your message.');
      expect(steers.at(-1)).toBeUndefined();
    },
  },
  {
    name: 'stops when its signal aborts, ending the open step',
    run: async (make) => {
      const abort = new AbortController();
      const input = runInput('wait forever', { signal: abort.signal });
      const running = backendOf(make).run(input);
      await vi.waitFor(() => expect(input.steps.some((s) => s.status === 'running')).toBe(true), 5_000);
      const started = Date.now();
      abort.abort();
      await expect(running).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(INTERRUPT_TIMEOUT_MS + 3_000);
      const last = input.steps.filter((s) => s.kind === 'tool').at(-1)!;
      expect(last.status).toBe('error');
    },
  },
  {
    name: "takes a friend's task only when it gates every tool or sandboxes every step, and a guest only when it gates",
    run: async (make) => {
      const rt = make();
      const run = backendOf(make).run(runInput('hello', { vetTool: () => undefined }));
      if (rt.capabilities.canGateEveryTool || rt.capabilities.hasSandbox) await expect(run).resolves.toBe('echo: hello');
      else await expect(run).rejects.toThrow(/friends/);
      const guest = backendOf(make).run(runInput('hello', { guest: true }));
      if (rt.capabilities.canGateEveryTool) await expect(guest).resolves.toBe('echo: hello');
      else await expect(guest).rejects.toThrow(/guests/);
    },
  },
  {
    name: 'lists its models exactly when it says it can',
    run: async (make) => {
      const rt = make();
      const models = await rt.create({ cwd: process.cwd(), autoEdit: false, additionalDirectories: [], bridge: room }).listModels?.();
      if (!rt.capabilities.hasModelList) return void expect(models ?? []).toEqual([]);
      expect(models?.length).toBeGreaterThan(0);
      for (const m of models!) expect(m).toMatchObject({ value: expect.any(String), label: expect.any(String) });
    },
  },
];

/** The scenarios a runtime fails, with why (none: it conforms). */
export async function conformanceFailures(make: () => AgentRuntime): Promise<string[]> {
  const failed: string[] = [];
  for (const s of SCENARIOS) {
    try {
      await s.run(make);
    } catch (err) {
      failed.push(`${s.name}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return failed;
}

export function runtimeConformance(name: string, make: () => AgentRuntime): void {
  describe(`${name}: runtime conformance`, () => {
    for (const s of SCENARIOS) it(s.name, () => s.run(make));
  });
}
