import { readFileSync } from 'node:fs';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { MAX_ATTACHMENT_BYTES, linkedImages, mediaTypeOf } from '../core/attachments.js';
import { buildAskOnlyAppend, buildPrompt, buildSystemAppend, summarizeTool } from './prompt.js';
import { decideTool, denyReason } from './policy.js';
import { buildSyncMainAppend, syncProbes } from './sync-main.js';
import { fromRateLimitEvent, fromUsageResponse } from './usage.js';
import { SubAgentTracker } from './subagents.js';
import { type RecorderMessage, StepRecorder } from './step-recorder.js';
import { type ContextMessage, ContextReport, breakdownReader, isCompactCommand } from './context-report.js';
import { compactEnv } from '../shared/context-usage.js';
import { BackgroundAgents, type PromptContent, PromptQueue, TurnRouter } from './live-run.js';
import { answerChat } from './chat-answer.js';
import { nameTask } from './namer.js';
import { createRoomTools } from './tools.js';
import { createTaskTools } from './task-tools.js';
import type { AgentBackend, AgentRunInput, FollowUp, RoomBridge } from './types.js';
import { type ClaudeAnswer, ClaudeQuestion, type Usage } from '../protocol.js';

const USAGE_TIMEOUT_MS = 20_000;
/** How long a run may stay open after answering while its background agents work. */
const BACKGROUND_LIMIT_MS = 3 * 60 * 60_000;
/**
 * Agents all done and Claude between turns for this long: end the run. Claude normally reports
 * on finished agents (and the run ends after that answer); this covers it not doing so. Not
 * instant, because an agent can resume right after its shell finishes.
 */
const QUIET_MS = 15_000;

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

/** A friend's task brings the tools its owner allowed (the screen, device info) as a server of their own. */
function taskServer(input: AgentRunInput): { klaud_task?: NonNullable<ReturnType<typeof createTaskTools>> } {
  const server = input.taskTools ? createTaskTools(input.taskTools) : undefined;
  return server ? { klaud_task: server } : {};
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
 * A prompt with images pasted into it: the text and each image as content blocks, so Claude
 * actually sees them. Without images, the plain text.
 */
export function imageContent(text: string, files: readonly string[]): PromptContent {
  const images = files.flatMap((file) => {
    try {
      const data = readFileSync(file);
      return data.length <= MAX_ATTACHMENT_BYTES ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: mediaTypeOf(file), data: data.toString('base64') } }] : [];
    } catch {
      return [];
    }
  });
  if (!images.length) return text;
  const note = `\n\n(${images.length === 1 ? 'The image linked above is' : 'The images linked above are'} attached to this message, in order.)`;
  return [{ type: 'text', text: text + note }, ...images];
}

/**
 * Ask Claude Code to send Claude's thinking as readable summaries (current models send it empty
 * unless asked), so screens can show it. Only the display changes: how much Claude thinks stays
 * the session's own. Older Claude Code without this control just ignores it.
 */
function showThinking(q: unknown): void {
  const set = (q as { setMaxThinkingTokens?: (max: number | null, display?: 'summarized') => Promise<void> }).setMaxThinkingTokens;
  if (typeof set !== 'function') return;
  try {
    void set.call(q, null, 'summarized').catch(() => undefined);
  } catch {
    // Not supported here: thinking shows as hidden.
  }
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
      // A project's main folder is questions only: nothing there changes (see policy.ts).
      const askOnly = place?.askOnly;
      const autoEdit = !askOnly && (place?.autoEdit ?? opts.autoEdit);
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const subagents = new SubAgentTracker(cwd);
      const syncMain = askOnly ? place?.syncMain : undefined;
      const policy = { cwd, roots: [cwd, ...extraDirs], autoEdit, scope: input.scope, guest: input.guest, askOnly: Boolean(askOnly), ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}) };
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
        mcpServers: { klaud: askOnly && input.continueInWorktree ? createRoomTools(opts.bridge, input.continueInWorktree) : roomTools, ...taskServer(input) },
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
                  const veto = input.vetTool?.(hookInput.tool_name, toolInput);
                  if (veto) return verdict('deny', veto);
                  const decision = decideTool(hookInput.tool_name, toolInput, policy);
                  if (decision === 'allow') return {};
                  if (decision === 'deny') return verdict('deny', denyReason(hookInput.tool_name, toolInput, policy));
                  return (await input.canUseTool(hookInput.tool_name, toolInput))
                    ? verdict('allow', 'Approved by the machine owner.')
                    : verdict('deny', 'The machine owner declined this action.');
                },
              ],
            },
          ],
          // The summary Claude keeps when it compacts, for the divider in the chat.
          PostCompact: [
            {
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name === 'PostCompact') report.summary(hookInput.compact_summary);
                  return {};
                },
              ],
            },
          ],
        },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(opts.bridge.selfName()) + (askOnly ? (syncMain ? buildSyncMainAppend(askOnly.project, syncMain.branch, syncMain.upstream) : buildAskOnlyAppend(askOnly.project, Boolean(input.continueInWorktree))) : '') },
        // Don't load settings files: a friend with :rw access could plant permission rules or hooks.
        settingSources: [],
        ...((input.model ?? opts.model) ? { model: input.model ?? opts.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        // Set, this replaces Claude Code's whole environment, so it starts from ours.
        // Claude Code's own auto-compact follows Klaud's threshold (see shared/context-usage.ts).
        ...((input.env && Object.keys(input.env).length) || input.autoCompactAt ? { env: { ...process.env, ...input.env, ...compactEnv(Boolean(input.autoCompactAt), input.autoCompactAt ?? 0) } } : {}),
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
        canUseTool: async (toolName, toolInput) => {
          if (toolName === 'AskUserQuestion') return answerQuestion(toolInput);
          if (toolName === 'ExitPlanMode') return reviewPlan(toolInput);
          const veto = input.vetTool?.(toolName, toolInput);
          if (veto) return { behavior: 'deny', message: veto };
          const decision = decideTool(toolName, toolInput, policy);
          if (decision === 'deny') return { behavior: 'deny', message: denyReason(toolName, toolInput, policy) };
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

      // The context meter, live: what Claude saw on each response, compactions and their summaries.
      const report = new ContextReport((kind, text) => input.onEvent(kind, text), input.model ?? opts.model);
      // Streaming input keeps Claude Code alive after it answers while background agents still
      // work: a one-shot prompt would cut them off 10 minutes later, rejecting their next step.
      const prompts = new PromptQueue();
      prompts.push(isCompactCommand(input.prompt) ? input.prompt.trim() : imageContent(buildPrompt(input), linkedImages(input.prompt)));
      const background = new BackgroundAgents();
      const turns = new TurnRouter({ onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}), ...(input.onAnswered ? { onDone: input.onAnswered } : {}) });
      // Steps in detail go to the request whose turn it is (a follow-up's turn: the follow-up).
      let stepTo = input.onStep;
      const recorder = new StepRecorder({ cwd, emit: (record) => stepTo?.(record) });
      recorder.begin();
      let limit: NodeJS.Timeout | undefined;
      let quiet: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (prompts.closed) return;
        clearTimeout(limit);
        clearTimeout(quiet);
        if (limit) input.onFollowUps?.(undefined); // only if follow-ups were offered
        turns.failPending('Claude finished before getting to this message');
        prompts.close();
      };
      const send = (followUp: FollowUp): boolean => {
        if (prompts.closed) return false;
        turns.queue(followUp);
        recorder.begin();
        return prompts.push(imageContent(buildPrompt(followUp), linkedImages(followUp.prompt)));
      };
      /** After an answer: end the run, or keep it open (taking follow-ups) while agents work. */
      const settle = (): void => {
        if (!background.busy && !turns.waiting) return finish();
        if (limit) return;
        limit = setTimeout(finish, BACKGROUND_LIMIT_MS);
        limit.unref();
        input.onFollowUps?.(send);
      };
      const done = (): boolean => turns.between && !background.busy && !turns.waiting;
      const watchQuiet = (): void => {
        clearTimeout(quiet);
        if (!limit || !done()) return;
        quiet = setTimeout(() => done() && finish(), QUIET_MS);
        quiet.unref();
      };
      abortController.signal.addEventListener('abort', finish, { once: true });

      const q = query({ prompt: prompts, options });
      showThinking(q);
      let failed = true;
      try {
        for await (const msg of q) {
          background.observe(msg as Parameters<BackgroundAgents['observe']>[0]);
          watchQuiet();
          if (msg.type === 'system' && msg.subtype === 'init') remember(msg.session_id);
          if (msg.type === 'rate_limit_event') {
            const update = fromRateLimitEvent(msg.rate_limit_info);
            if (update) opts.bridge.reportUsage(update);
          }
          if (msg.type === 'assistant') {
            for (const e of subagents.assistant(msg.parent_tool_use_id, msg.message.content)) input.onEvent('sub', JSON.stringify(e));
          }
          report.observe(msg as ContextMessage);
          if (msg.type === 'system' && 'task_id' in msg) {
            for (const e of subagents.task(msg as Parameters<SubAgentTracker['task']>[0])) input.onEvent('sub', JSON.stringify(e));
          }
          const route = msg.type === 'assistant' && msg.parent_tool_use_id === null ? turns.current() : undefined;
          if (route) stepTo = route.onStep;
          recorder.observe(msg as RecorderMessage);
          if (msg.type === 'user' && msg.parent_tool_use_id === null) {
            for (const e of subagents.user(msg.message.content as never)) input.onEvent('sub', JSON.stringify(e));
          }
          if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                lastText = block.text.trim();
                route?.onEvent('text', lastText);
              }
              if (block.type === 'tool_use' && !subagents.isLaunch(block)) {
                const toolInput = (block.input ?? {}) as Record<string, unknown>;
                route?.onEvent('tool', summarizeTool(block.name, toolInput, cwd));
                if (WRITE_TOOLS.has(block.name) && typeof toolInput.file_path === 'string') {
                  input.onFileTouched(toolInput.file_path);
                }
              }
            }
          }
          if (msg.type === 'result') {
            remember(msg.session_id);
            await report.result(msg.modelUsage, breakdownReader(q));
            const turn = turns.current();
            turn.onEvent('usage', JSON.stringify(usageOf(msg.modelUsage ?? {}, msg.total_cost_usd ?? 0, msg.session_id)));
            const stopped = `Agent stopped: ${msg.subtype.replace(/_/g, ' ')}`;
            // A later turn failing (e.g. reporting a finished agent) doesn't throw away answers already given.
            if (!turns.end(msg.subtype === 'success', msg.subtype === 'success' ? msg.result : stopped) && !turns.answers.length) throw new Error(stopped);
            settle();
          }
        }
        failed = false;
      } finally {
        recorder.finish(failed || abortController.signal.aborted);
        finish();
      }
      return turns.answers.join('\n\n');
    },

    nameTask: (prompt: string) => nameTask(prompt, { cwd: opts.cwd, claudePath: opts.claudePath }),
    answerChat: (req) => answerChat(req, { cwd: opts.cwd, ...(opts.claudePath ? { claudePath: opts.claudePath } : {}), ...(opts.model ? { model: opts.model } : {}) }),

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
