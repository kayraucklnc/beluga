import { randomUUID } from 'node:crypto';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { scriptedWords } from './runtime-conformance.js';

/**
 * A scripted Claude Code behind the Agent SDK's `query`, following the conformance script
 * (runtime-conformance.ts) with the messages Claude Code streams (system init, assistant tool_use
 * and text, user tool_result, result with modelUsage), its PreToolUse hook asked before every tool
 * as Claude Code asks it, and interrupt() ending the running turn with an error_during_execution
 * result. Sessions outlive a query, as Claude Code keeps them on disk, so one resumes later.
 *
 * Use with `vi.mock('@anthropic-ai/claude-agent-sdk', …)` swapping `query` for `fakeClaude.query`.
 */
type Prompt = { readonly message: { readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }> }; readonly uuid?: string };

export class FakeClaude {
  readonly sessions = new Set<string>();
  /** The options each query was made with (for assertions). */
  readonly options: Options[] = [];

  readonly query = ({ prompt, options = {} }: { prompt: AsyncIterable<Prompt>; options?: Options }) => {
    this.options.push(options);
    const sessions = this.sessions;
    const signal = options.abortController?.signal;
    let stop: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user')), { once: true }));
    void aborted.catch(() => undefined);
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback | undefined;

    const resumed = options.resume && sessions.has(options.resume) && !options.forkSession ? options.resume : undefined;
    const session = resumed ?? randomUUID();
    sessions.add(session);

    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: session };
      for await (const msg of prompt) {
        const content = msg.message.content;
        const words = scriptedWords(typeof content === 'string' ? content : (content.find((b) => b.type === 'text')?.text ?? ''));
        const id = `toolu_${randomUUID().slice(0, 8)}`;
        const command = `echo ${words}`;
        yield { type: 'assistant', parent_tool_use_id: null, session_id: session, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } };
        const verdict = (await hook?.({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id, session_id: session, transcript_path: '', cwd: options.cwd ?? '' } as never, id, { signal: new AbortController().signal })) as
          | { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
          | undefined;
        const usage = { modelUsage: { 'claude-fake': { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 } }, total_cost_usd: 0.001, session_id: session, user_message_uuids: msg.uuid ? [msg.uuid] : [] };
        if (verdict?.hookSpecificOutput?.permissionDecision === 'deny') {
          yield { type: 'user', parent_tool_use_id: null, session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: id, content: verdict.hookSpecificOutput.permissionDecisionReason ?? 'Denied', is_error: true }] } };
          yield { type: 'assistant', parent_tool_use_id: null, session_id: session, message: { content: [{ type: 'text', text: `denied: ${words}` }] } };
          yield { type: 'result', subtype: 'success', is_error: false, result: `denied: ${words}`, ...usage };
          continue;
        }
        if (words.startsWith('wait')) {
          await Promise.race([new Promise<void>((resolve) => (stop = resolve)), aborted]);
          stop = undefined;
          yield { type: 'user', parent_tool_use_id: null, session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Interrupted', is_error: true }] } };
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [], ...usage };
          continue;
        }
        yield { type: 'user', parent_tool_use_id: null, session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `${words}\n`, is_error: false }] } };
        yield { type: 'assistant', parent_tool_use_id: null, session_id: session, message: { content: [{ type: 'text', text: `echo: ${words}` }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: `echo: ${words}`, ...usage };
      }
    }

    return Object.assign(run(), {
      interrupt: async () => stop?.(),
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedModels: async () => [{ value: 'default', displayName: 'Default (Opus)', description: 'The best', supportedEffortLevels: ['low', 'high'] }],
      close: () => undefined,
    });
  };
}
