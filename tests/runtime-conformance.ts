import { describe, expect, it, vi } from 'vitest';
import { guardedBackend } from '../src/agent/runtime/guard.js';
import { type AgentRuntime, INTERRUPT_TIMEOUT_MS } from '../src/agent/runtime/types.js';
import type { AgentBackend, AgentPlace, AgentRunInput, FollowUp, RoomBridge, Steer } from '../src/agent/types.js';
import type { StepRecord } from '../src/shared/steps.js';

/**
 * The runtime conformance suite (BLG-453): what every AgentRuntime must do the same way, so the
 * session layer and the screens never need to know which agent ran. A runtime is tested against a
 * scripted agent behind it (the fake runtime is one; Codex's test scripts its app-server), which
 * follows this script:
 *
 * - a prompt `P` is answered `echo: P`, after one shell step running `echo P`;
 * - a prompt starting with `wait` keeps working (a shell step that never ends) until interrupted.
 *
 * The prompt the agent sees is Beluga's built prompt; the script reads its last line as `P`.
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

/** The words a scripted agent reads from a built prompt: its last line. */
export const scriptedWords = (prompt: string): string => prompt.trim().split('\n').at(-1)!.trim();

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

export function runtimeConformance(name: string, make: () => AgentRuntime): void {
  describe(`${name}: runtime conformance`, () => {
    const backend = (): AgentBackend => {
      const rt = make();
      return guardedBackend(rt.create({ cwd: process.cwd(), autoEdit: true, additionalDirectories: [], bridge: room }), rt.capabilities);
    };

    it('says what it can do', () => {
      const rt = make();
      expect(rt.id).toMatch(/^[a-z][\w-]*$/);
      expect(rt.label).toBeTruthy();
      for (const [key, value] of Object.entries(rt.capabilities)) if (key !== 'toolMounts' && key !== 'skills') expect(typeof value, key).toBe('boolean');
      expect(['native', 'mapped']).toContain(rt.capabilities.skills);
      expect(rt.capabilities.toolMounts.length).toBeGreaterThan(0);
    });

    it('answers a prompt, with its text and its step streamed as they happen', async () => {
      const input = runInput('hello');
      const answered = vi.fn();
      expect(await backend().run({ ...input, onAnswered: answered })).toBe('echo: hello');
      expect(answered).toHaveBeenCalledWith('echo: hello');
      expect(input.events).toContainEqual(['text', 'echo: hello']);
      expect(input.events.some(([kind]) => kind === 'tool')).toBe(true);
      // One Bash step: running, then done, under one id, in Beluga's own words.
      const bash = input.steps.filter((s) => s.kind === 'tool');
      expect(bash[0]).toMatchObject({ tool: 'Bash', status: 'running', input: { command: 'echo hello' } });
      expect(bash.at(-1)).toMatchObject({ id: bash[0]!.id, tool: 'Bash', status: 'done', label: expect.any(String) });
      expect(bash.at(-1)!.output).toContain('hello');
    });

    it('keeps its conversation per place, and resumes it', async () => {
      const first = place();
      await backend().run(runInput('one', { place: first }));
      expect(first.sessions).toHaveLength(1);
      const again = place({ resume: first.sessions[0]! });
      expect(await backend().run(runInput('two', { place: again }))).toBe('echo: two');
      expect(again.sessions).toEqual(first.sessions);
    });

    it('interrupts a running turn within the timeout, and answers the message in the next', async () => {
      const rt = make();
      if (!rt.capabilities.canInterrupt) return;
      const steers: Array<Steer | undefined> = [];
      const input = runInput('wait for it', { onSteer: (s) => void steers.push(s) });
      const running = backend().run(input);
      const steer = await steerWhenWorking(steers, input);
      const next = followUp('after');
      const started = Date.now();
      expect(await steer.interrupt!(next, 'Stopped for your message.')).toBe(true);
      expect(Date.now() - started).toBeLessThan(INTERRUPT_TIMEOUT_MS);
      expect(await next.answer).toBe('echo: after');
      expect(await running).toContain('Stopped for your message.');
      expect(steers.at(-1)).toBeUndefined();
    });

    it('stops when its signal aborts, ending the open step', async () => {
      const abort = new AbortController();
      const input = runInput('wait forever', { signal: abort.signal });
      const running = backend().run(input);
      await vi.waitFor(() => expect(input.steps.some((s) => s.status === 'running')).toBe(true), 5_000);
      const started = Date.now();
      abort.abort();
      await expect(running).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(INTERRUPT_TIMEOUT_MS + 3_000);
      const last = input.steps.filter((s) => s.kind === 'tool').at(-1)!;
      expect(last.status).toBe('error');
    });

    it("takes a friend's task only when it gates every tool or sandboxes every step, and a guest only when it gates", async () => {
      const rt = make();
      const run = backend().run(runInput('hello', { vetTool: () => undefined }));
      if (rt.capabilities.canGateEveryTool || rt.capabilities.hasSandbox) await expect(run).resolves.toBe('echo: hello');
      else await expect(run).rejects.toThrow(/friends/);
      const guest = backend().run(runInput('hello', { guest: true }));
      if (rt.capabilities.canGateEveryTool) await expect(guest).resolves.toBe('echo: hello');
      else await expect(guest).rejects.toThrow(/guests/);
    });

    it('lists its models when it says it can', async () => {
      const rt = make();
      const models = await rt.create({ cwd: process.cwd(), autoEdit: false, additionalDirectories: [], bridge: room }).listModels?.();
      if (!rt.capabilities.hasModelList) return;
      expect(models?.length).toBeGreaterThan(0);
      for (const m of models!) expect(m).toMatchObject({ value: expect.any(String), label: expect.any(String) });
    });
  });
}
