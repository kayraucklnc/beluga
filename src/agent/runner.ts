import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { buildPrompt, buildSystemAppend, summarizeTool } from './prompt.js';
import { decideTool } from './policy.js';
import { createRoomTools } from './tools.js';
import type { AgentBackend, AgentRunInput, RoomBridge } from './types.js';

export interface ClaudeBackendOptions {
  readonly cwd: string;
  /** Let the agent edit files in cwd without asking (share was marked :rw). */
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  readonly claudePath?: string;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Runs turns through the Claude Agent SDK, which drives the local Claude Code
 * install and therefore uses the owner's own login/subscription. One session
 * is kept per room so the agent remembers the conversation.
 */
export function createClaudeBackend(opts: ClaudeBackendOptions): AgentBackend {
  let sessionId: string | undefined;
  const roomTools = createRoomTools(opts.bridge);

  return {
    async run(input: AgentRunInput): Promise<string> {
      const abortController = new AbortController();
      input.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      const roots = [opts.cwd, ...opts.additionalDirectories];
      const options: Options = {
        cwd: opts.cwd,
        additionalDirectories: [...opts.additionalDirectories],
        resume: sessionId,
        abortController,
        permissionMode: opts.autoEdit ? 'acceptEdits' : 'default',
        mcpServers: { klaude: roomTools },
        // Hooks run even for tools Claude Code would auto-allow, so secrets stay off-limits.
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name !== 'PreToolUse') return {};
                  const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                  if (decideTool(hookInput.tool_name, toolInput, opts.cwd, roots) !== 'deny') return {};
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: 'klaude blocks agents from reading credential files.',
                    },
                  };
                },
              ],
            },
          ],
        },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(opts.bridge.selfName()) },
        // Don't load settings files: a friend with :rw access could plant permission rules or hooks.
        settingSources: [],
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
        canUseTool: async (toolName, toolInput) => {
          const decision = decideTool(toolName, toolInput, opts.cwd, roots);
          if (decision === 'deny') return { behavior: 'deny', message: 'klaude blocks agents from reading credential files.' };
          if (decision === 'allow' || (await input.canUseTool(toolName, toolInput))) return { behavior: 'allow', updatedInput: toolInput };
          return { behavior: 'deny', message: 'The machine owner declined this action.' };
        },
      };

      let final = '';
      for await (const msg of query({ prompt: buildPrompt(input), options })) {
        if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id;
        if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) input.onEvent('text', block.text.trim());
            if (block.type === 'tool_use') {
              const toolInput = (block.input ?? {}) as Record<string, unknown>;
              input.onEvent('tool', summarizeTool(block.name, toolInput));
              if (WRITE_TOOLS.has(block.name) && typeof toolInput.file_path === 'string') {
                input.onFileTouched(toolInput.file_path);
              }
            }
          }
        }
        if (msg.type === 'result') {
          sessionId = msg.session_id;
          if (msg.subtype === 'success') final = msg.result;
          else throw new Error(`Agent stopped: ${msg.subtype.replace(/_/g, ' ')}`);
        }
      }
      return final;
    },
  };
}
