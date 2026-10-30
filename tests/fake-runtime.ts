import { randomUUID } from 'node:crypto';
import { buildPrompt } from '../src/agent/prompt.js';
import type { AgentRuntime, RuntimeCapabilities } from '../src/agent/runtime/types.js';
import type { AgentRunInput, FollowUp, Steer } from '../src/agent/types.js';
import type { StepRecord } from '../src/shared/steps.js';
import { scriptedWords } from './runtime-conformance.js';

/**
 * The reference runtime for the conformance suite: in memory, following its script (see
 * runtime-conformance.ts). Gates every tool, so it's what a fully capable runtime does.
 */
export const FAKE_CAPABILITIES: RuntimeCapabilities = {
  canGateEveryTool: true,
  hasSandbox: false,
  canSteer: false,
  canInterrupt: true,
  hasPlanMode: false,
  hasSubagents: false,
  hasBackgroundAgents: false,
  hasUsage: false,
  canResume: true,
  canFork: false,
  canAskUser: false,
  hasCompaction: false,
  hasModelList: true,
  hasProcess: false,
  skills: 'native',
  promptImages: false,
  toolMounts: ['in-process'],
};

export function createFakeRuntime(): AgentRuntime {
  return {
    id: 'fake',
    label: 'Fake',
    capabilities: FAKE_CAPABILITIES,
    complete: async (req) => `echo: ${req.prompt}`,
    create: () => ({
      listModels: async () => [{ value: '', label: 'Fake', description: 'The only one' }],
      async run(input: AgentRunInput): Promise<string> {
        if (input.signal.aborted) throw new Error('aborted');
        const session = input.place?.resume ?? randomUUID();
        input.place?.onSession(session);
        let interrupt: { readonly note: string; readonly next: FollowUp } | undefined;
        let wake: (() => void) | undefined;
        const turn = async (prompt: string, onEvent: AgentRunInput['onEvent'], onStep?: (r: StepRecord) => void): Promise<string | undefined> => {
          const words = scriptedWords(prompt);
          const id = randomUUID();
          const startedAt = Date.now();
          const base = { id, kind: 'tool' as const, tool: 'Bash', title: `Bash echo ${words}`, label: `Ran echo ${words}`, startedAt, input: { command: `echo ${words}` } };
          onEvent('tool', base.title);
          onStep?.({ ...base, status: 'running' });
          if (words.startsWith('wait')) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              input.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            onStep?.({ ...base, status: 'error', isError: true, output: 'Stopped before it finished', endedAt: Date.now() });
            if (input.signal.aborted) throw new Error('aborted');
            return undefined;
          }
          onStep?.({ ...base, status: 'done', output: words, endedAt: Date.now() });
          const text = `echo: ${words}`;
          onEvent('text', text);
          return text;
        };
        const steer = Object.assign(() => false, {
          interrupt: async (next: FollowUp, note: string) => {
            if (!wake) return false;
            interrupt = { note, next };
            wake();
            return true;
          },
        }) satisfies Steer;
        input.onSteer?.(steer);
        try {
          let answer = await turn(buildPrompt(input), input.onEvent, input.onStep);
          if (answer === undefined && interrupt) {
            input.onEvent('text', interrupt.note);
            answer = interrupt.note;
          }
          input.onAnswered?.(answer ?? '');
          if (interrupt) {
            const { next } = interrupt;
            next.onStart?.();
            next.onDone((await turn(buildPrompt(next), next.onEvent, next.onStep)) ?? '');
          }
          return answer ?? '';
        } finally {
          input.onSteer?.(undefined);
        }
      },
    }),
  };
}
