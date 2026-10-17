import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { buildPrompt, buildSystemAppend, summarizeTool } from './prompt.js';
import { DENY_REASON, decideTool } from './policy.js';
import { fromRateLimitEvent, fromUsageResponse } from './usage.js';
import { SubAgentTracker } from './subagents.js';
import { nameTask } from './namer.js';
import { createRoomTools } from './tools.js';
import type { AgentBackend, AgentRunInput, RoomBridge } from './types.js';
import { type ClaudeAnswer, ClaudeQuestion, type Usage } from '../protocol.js';

const USAGE_TIMEOUT_MS = 20_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

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
/** Tools that talk to the person instead of touching anything: answered through askUser, not approvals. */
const INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Claude's AskUserQuestion input → our question card (unknown shapes are dropped safely). */
export function toQuestion(input: Record<string, unknown>): ClaudeQuestion | undefined {
  const parsed = ClaudeQuestion.safeParse({ kind: 'question', questions: input.questions });
  return parsed.success ? parsed.data : undefined;
}

/** Tokens and cost of a run, summed over every model it used (sub-agents included). */
export function usageOf(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>, cost: number, session: string) {
  const all = Object.values(modelUsage);
  const sum = (pick: (u: (typeof all)[number]) => number): number => all.reduce((n, u) => n + (pick(u) || 0), 0);
  return { input: sum((u) => u.inputTokens), output: sum((u) => u.outputTokens), cacheRead: sum((u) => u.cacheReadInputTokens), cacheWrite: sum((u) => u.cacheCreationInputTokens), cost, session };
}

/** Friendly rows for the model picker from Claude Code's own list. */
export function toModelChoices(models: ReadonlyArray<{ value: string; displayName: string; description: string; supportedEffortLevels?: readonly string[] }>) {
  return models.map((m) => ({ value: m.value === 'default' ? '' : m.value, label: m.displayName, description: m.description, ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels } : {}) }));
}

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
      // A workspace brings its own folder and conversation; otherwise use the room's.
      const place = input.place;
      const cwd = place?.cwd ?? opts.cwd;
      const extraDirs = place ? place.additionalDirectories : opts.additionalDirectories;
      const autoEdit = place?.autoEdit ?? opts.autoEdit;
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const subagents = new SubAgentTracker(cwd);
      const policy = { cwd, roots: [cwd, ...extraDirs], autoEdit, scope: input.scope };
      const verdict = (permissionDecision: 'allow' | 'deny', reason: string) => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision, permissionDecisionReason: reason },
      });
      const options: Options = {
        cwd,
        additionalDirectories: [...extraDirs],
        resume: place ? place.resume : sessionId,
        ...(place?.forkSession && place.resume ? { forkSession: true } : {}),
        abortController,
        permissionMode: input.plan ? 'plan' : autoEdit ? 'acceptEdits' : 'default',
        mcpServers: { klaud: roomTools },
        // The hook runs before Claude Code's own permission logic, even for commands it would
        // auto-approve, so the machine owner stays in control of every risky action.
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name !== 'PreToolUse') return {};
                  if (INTERACTIVE.has(hookInput.tool_name)) return {}; // answered in canUseTool
                  const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
                  const decision = decideTool(hookInput.tool_name, toolInput, policy);
                  if (decision === 'allow') return {};
                  if (decision === 'deny') return verdict('deny', DENY_REASON);
                  return (await input.canUseTool(hookInput.tool_name, toolInput))
                    ? verdict('allow', 'Approved by the machine owner.')
                    : verdict('deny', 'The machine owner declined this action.');
                },
              ],
            },
          ],
        },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(opts.bridge.selfName()) },
        // Don't load settings files: a friend with :rw access could plant permission rules or hooks.
        settingSources: [],
        ...((input.model ?? opts.model) ? { model: input.model ?? opts.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
        canUseTool: async (toolName, toolInput) => {
          if (toolName === 'AskUserQuestion') return answerQuestion(toolInput);
          if (toolName === 'ExitPlanMode') return reviewPlan(toolInput);
          const decision = decideTool(toolName, toolInput, policy);
          if (decision === 'deny') return { behavior: 'deny', message: DENY_REASON };
          if (decision === 'allow' || (await input.canUseTool(toolName, toolInput))) return { behavior: 'allow', updatedInput: toolInput };
          return { behavior: 'deny', message: 'The machine owner declined this action.' };
        },
      };

      let lastText = '';
      const ask = async (question: ClaudeQuestion): Promise<ClaudeAnswer> => (input.askUser ? input.askUser(question) : { kind: 'skip' });
      const answerQuestion = async (toolInput: Record<string, unknown>) => {
        const question = toQuestion(toolInput);
        const answer = question ? await ask(question) : ({ kind: 'skip' } as const);
        if (answer.kind === 'answers') return { behavior: 'allow' as const, updatedInput: { ...toolInput, answers: answer.answers } };
        return { behavior: 'deny' as const, message: 'The user skipped this question. Continue with your best judgment and say what you assumed.' };
      };
      const reviewPlan = async (toolInput: Record<string, unknown>) => {
        const plan = typeof toolInput.plan === 'string' && toolInput.plan.trim() ? toolInput.plan : lastText || '(Claude proposed a plan)';
        const answer = await ask({ kind: 'plan', plan: plan.slice(0, 60_000) });
        if (answer.kind === 'plan' && answer.approve) {
          // Approved: leave plan mode so Claude can do the work.
          await q.setPermissionMode(autoEdit ? 'acceptEdits' : 'default').catch(() => undefined);
          return { behavior: 'allow' as const, updatedInput: toolInput };
        }
        const feedback = answer.kind === 'plan' && answer.feedback ? `The user wants changes to the plan: ${answer.feedback}` : 'The user did not approve the plan yet. Ask what they would like to change.';
        return { behavior: 'deny' as const, message: feedback };
      };

      let final = '';
      let contextUsed = 0;
      const q = query({ prompt: buildPrompt(input), options });
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') remember(msg.session_id);
        if (msg.type === 'rate_limit_event') {
          const update = fromRateLimitEvent(msg.rate_limit_info);
          if (update) opts.bridge.reportUsage(update);
        }
        if (msg.type === 'assistant') {
          for (const e of subagents.assistant(msg.parent_tool_use_id, msg.message.content)) input.onEvent('sub', JSON.stringify(e));
        }
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          const meta = msg.compact_metadata;
          input.onEvent('compact', JSON.stringify({ pre: meta.pre_tokens, post: meta.post_tokens ?? 0, trigger: meta.trigger }));
          contextUsed = meta.post_tokens ?? 0;
        }
        if (msg.type === 'assistant' && msg.parent_tool_use_id === null && msg.message.usage) {
          const u = msg.message.usage;
          contextUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        }
        if (msg.type === 'system' && 'task_id' in msg) {
          for (const e of subagents.task(msg as Parameters<SubAgentTracker['task']>[0])) input.onEvent('sub', JSON.stringify(e));
        }
        if (msg.type === 'user' && msg.parent_tool_use_id === null) {
          for (const e of subagents.user(msg.message.content as never)) input.onEvent('sub', JSON.stringify(e));
        }
        if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              lastText = block.text.trim();
              input.onEvent('text', lastText);
            }
            if (block.type === 'tool_use' && !subagents.isLaunch(block)) {
              const toolInput = (block.input ?? {}) as Record<string, unknown>;
              input.onEvent('tool', summarizeTool(block.name, toolInput, cwd));
              if (WRITE_TOOLS.has(block.name) && typeof toolInput.file_path === 'string') {
                input.onFileTouched(toolInput.file_path);
              }
            }
          }
        }
        if (msg.type === 'result') {
          remember(msg.session_id);
          const window = Object.values(msg.modelUsage ?? {})[0]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
          if (contextUsed) input.onEvent('context', JSON.stringify({ used: contextUsed, window }));
          input.onEvent('usage', JSON.stringify(usageOf(msg.modelUsage ?? {}, msg.total_cost_usd ?? 0, msg.session_id)));
          if (msg.subtype === 'success') final = msg.result;
          else throw new Error(`Agent stopped: ${msg.subtype.replace(/_/g, ' ')}`);
        }
      }
      return final;
    },

    nameTask: (prompt: string) => nameTask(prompt, { cwd: opts.cwd, claudePath: opts.claudePath }),

    /** Ask Claude Code which models it offers (no prompt is sent). */
    async listModels() {
      const idle = (async function* () {
        await new Promise(() => undefined);
      })() as AsyncIterable<never>;
      const q = query({ prompt: idle, options: { cwd: opts.cwd, settingSources: [], ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}) } });
      try {
        const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), USAGE_TIMEOUT_MS).unref());
        const models = await Promise.race([q.supportedModels(), timeout]);
        return models?.length ? toModelChoices(models) : undefined;
      } catch {
        return undefined;
      } finally {
        q.close();
      }
    },

    /**
     * Read plan usage without sending a prompt: open a session whose input never
     * yields, ask for /usage data, then close it. Uses an experimental SDK call,
     * so it is feature-detected and failures are ignored.
     */
    async refreshUsage(): Promise<Usage | undefined> {
      const idle = (async function* () {
        await new Promise(() => undefined);
      })() as AsyncIterable<never>;
      const q = query({
        prompt: idle,
        options: { cwd: opts.cwd, settingSources: [], ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}) },
      });
      const getUsage = (q as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      try {
        if (typeof getUsage !== 'function') return undefined;
        const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), USAGE_TIMEOUT_MS).unref());
        const res = await Promise.race([getUsage.call(q, { skipBehaviors: true }), timeout]);
        return res ? fromUsageResponse(res as Parameters<typeof fromUsageResponse>[0]) : undefined;
      } catch {
        return undefined;
      } finally {
        q.close();
      }
    },
  };
}
