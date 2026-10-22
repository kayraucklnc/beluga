import { readFileSync } from 'node:fs';
import path from 'node:path';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { MAX_ATTACHMENT_BYTES, linkedImages, mediaTypeOf } from '../core/attachments.js';
import { buildAskOnlyAppend, buildPrompt, buildScratchAppend, buildSystemAppend, summarizeTool } from './prompt.js';
import { buildGraphAppend } from './graph-prompt.js';
import { createBoardTools } from './board-tools.js';
import { createPlanTools } from './plan-tools.js';
import { decideTool, denyReason } from './policy.js';
import { buildSyncMainAppend, syncProbes } from './sync-main.js';
import { fromRateLimitEvent, fromUsageResponse, toMs } from './usage.js';
import { RunFailedError, classifyRun } from '../shared/run-failure.js';
import { SubAgentTracker, withAgentScratch } from './subagents.js';
import { type RecorderMessage, StepRecorder } from './step-recorder.js';
import { type ContextMessage, ContextReport, breakdownReader, isCompactCommand } from './context-report.js';
import { compactEnv } from '../shared/context-usage.js';
import { progressCount } from '../shared/progress-count.js';
import { BackgroundAgents, type PromptContent, PromptQueue, TurnRouter } from './live-run.js';
import { answerChat } from './chat-answer.js';
import { nameTask } from './namer.js';
import { fixSetup } from './setup-fixer.js';
import { draftTask } from './task-drafter.js';
import { createRoomTools } from './tools.js';
import { createTaskTools } from './task-tools.js';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, RoomBridge, RunProcess, Steer } from './types.js';
import { keepLines, trackedSpawn } from './claude-process.js';
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
/** Claude Code's last stderr lines kept for a failed run's details. */
const STDERR_KEEP = 40;
/** How long Claude Code gets to stop a turn when asked (see Steer.interrupt). */
const INTERRUPT_TIMEOUT_MS = 10_000;

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

/** Your own runs get the task board (core/board): the task they're doing, and tools to keep it true. */
function boardServer(input: AgentRunInput): { klaud_board?: ReturnType<typeof createBoardTools> } {
  return input.board ? { klaud_board: createBoardTools(input.board) } : {};
}

/** A plan's home conversation gets the plan's tools (core/plans). */
function planServer(input: AgentRunInput): { klaud_plan?: ReturnType<typeof createPlanTools> } {
  return input.planTools ? { klaud_plan: createPlanTools(input.planTools) } : {};
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

/** The text of the tool results in a message from Claude Code (what its commands printed). */
function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const text = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x && typeof x.text === 'string' ? x.text : '')).join('\n') : '');
  return content.map((b) => (b && typeof b === 'object' && 'type' in b && b.type === 'tool_result' && 'content' in b ? text(b.content) : '')).join('\n');
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
      const scratchRoot = input.scratchDir ? path.resolve(cwd, input.scratchDir) : undefined;
      const syncMain = askOnly ? place?.syncMain : undefined;
      const fixup = askOnly ? place?.fixup : undefined;
      const policy = { cwd, roots: [cwd, ...extraDirs, ...(fixup ? [fixup] : [])], autoEdit, scope: input.scope, guest: input.guest, askOnly: Boolean(askOnly), ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}), ...(fixup ? { fixup } : {}) };
      // How the run ends, when it fails: Claude Code's stderr, a limit that said no, an API error.
      const stderr: string[] = [];
      const keepStderr = (data: string): void => keepLines(stderr, data, STDERR_KEEP);
      // Claude Code's process, so a run that won't end can be told dead and killed (see AgentRunInput.onProcess).
      // The SDK reads no stderr from a process we spawn: ours feeds the same lines a crash is told by.
      let proc: RunProcess | undefined;
      const tracked = input.onProcess
        ? trackedSpawn((p) => {
            proc = p;
            input.onProcess?.(p);
          }, keepStderr)
        : undefined;
      const verdict = (permissionDecision: 'allow' | 'deny', reason: string) => ({
        hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision, permissionDecisionReason: reason },
      });
      let rejectedUntil: number | undefined;
      let apiError: string | undefined;
      let failedResult: string | undefined;
      const options: Options = {
        cwd,
        additionalDirectories: [...extraDirs, ...(fixup ? [fixup] : [])],
        resume: place ? place.resume : sessionId,
        ...(place?.forkSession && place.resume ? { forkSession: true } : {}),
        abortController,
        permissionMode: input.plan ? 'plan' : autoEdit ? 'acceptEdits' : 'default',
        mcpServers: { klaud: askOnly && input.continueInWorktree ? createRoomTools(opts.bridge, input.continueInWorktree) : roomTools, ...taskServer(input), ...boardServer(input), ...planServer(input) },
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
                  if (decision === 'deny') return verdict('deny', denyReason(hookInput.tool_name, toolInput, policy));
                  // A sub-agent is told where its own scratch folder is, so what it makes shows on its page.
                  const patched = scratchRoot ? withAgentScratch(hookInput.tool_name, toolInput, hookInput.tool_use_id, scratchRoot) : undefined;
                  const allow = (reason: string) => (patched ? { hookSpecificOutput: { ...verdict('allow', reason).hookSpecificOutput, updatedInput: patched } } : verdict('allow', reason));
                  if (decision === 'allow') return patched ? allow('Allowed by klaud.') : {};
                  return (await input.canUseTool(hookInput.tool_name, toolInput)) ? allow('Approved by the machine owner.') : verdict('deny', 'The machine owner declined this action.');
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
        systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(opts.bridge.selfName()) + buildGraphAppend() + (input.taskBrief ?? '') + (input.planBrief ?? '') + (input.scratchDir ? buildScratchAppend(input.scratchDir) : '') + (askOnly ? (syncMain ? buildSyncMainAppend(askOnly.project, syncMain.branch, syncMain.upstream) : buildAskOnlyAppend(askOnly.project, Boolean(input.continueInWorktree))) : '') },
        // Don't load settings files: a friend with :rw access could plant permission rules or hooks.
        settingSources: [],
        ...((input.model ?? opts.model) ? { model: input.model ?? opts.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        // Set, this replaces Claude Code's whole environment, so it starts from ours.
        // Claude Code's own auto-compact follows Klaud's threshold (see shared/context-usage.ts).
        ...((input.env && Object.keys(input.env).length) || input.autoCompactAt ? { env: { ...process.env, ...input.env, ...compactEnv(Boolean(input.autoCompactAt), input.autoCompactAt ?? 0) } } : {}),
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
        // Its last words, so a crash says why (see shared/run-failure.ts): read by our own spawn when there is one.
        ...(tracked ? { spawnClaudeCodeProcess: tracked.spawn } : { stderr: keepStderr }),
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
      let askedToDefine = false;
      const reviewPlan = async (toolInput: Record<string, unknown>) => {
        // The plan is for a task: Claude defines it (in its own words) before the plan comes to you. Asked once.
        if (input.planTask?.needsDefinition() && !askedToDefine) {
          askedToDefine = true;
          return { behavior: 'deny' as const, message: 'Before asking for approval, call mcp__klaud_board__task_define with the task this plan is for (title, goal in your own words, context, acceptance criteria, decisions, open questions, estimate, priority). Then call ExitPlanMode again.' };
        }
        const plan = typeof toolInput.plan === 'string' && toolInput.plan.trim() ? toolInput.plan : lastText || '(Claude proposed a plan)';
        const answer = await ask({ kind: 'plan', plan: plan.slice(0, 60_000) });
        if (answer.kind === 'plan' && answer.approve) {
          input.planTask?.approved();
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
        input.onSteer?.(undefined);
        turns.failPending('Claude finished before getting to this message');
        prompts.close();
      };
      /** A message into the live session. `steer`: Claude works on a turn, and takes it in at its next step. */
      const deliver = (followUp: FollowUp, steer: boolean): string | false => {
        if (prompts.closed) return false;
        // Between turns it starts one now: thinking before its first step counts from here.
        if (turns.between) recorder.begin();
        const uuid = prompts.push(imageContent(buildPrompt(followUp), linkedImages(followUp.prompt)), { steer: steer && !turns.between });
        if (uuid === false) return false;
        turns.queue(followUp, uuid, steer && !turns.between);
        return uuid;
      };
      const send = (followUp: FollowUp): boolean => deliver(followUp, false) !== false;
      // What Claude is doing now, for a steer to judge whether it reads a message soon (see Steer.status).
      const tools = new Map<string, { label: string; since: number }>();
      let lastEventAt = Date.now();
      /** Claude's last word in the main conversation was thinking. */
      let thinking = false;
      const status = (): LiveStatus => {
        const tool = [...tools.values()].sort((a, b) => a.since - b.since)[0];
        return { ...(tool ? { tool } : {}), lastEventAt, between: turns.between, ...(thinking ? { thinking } : {}), ...(proc ? { alive: proc.alive() } : {}) };
      };
      /** Set while a turn is being interrupted: what that turn ends with, and the run stays open for the next. */
      let interrupting: string | undefined;
      /** The message an interrupt is for: its own turn, never folded into the interrupted one. */
      let interruptFor: string | undefined;
      /** After an answer: end the run, or keep it open (taking follow-ups) while agents work. */
      const settle = (): void => {
        if (interrupting === undefined && !background.busy && !turns.waiting) return finish();
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
      /** Stop the running tool and turn, then answer `followUp` in the next turn (see Steer.interrupt). */
      const interrupt = async (followUp: FollowUp, note: string): Promise<boolean> => {
        if (prompts.closed || turns.between || interrupting !== undefined) return false;
        interrupting = note;
        try {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('interrupt timed out')), INTERRUPT_TIMEOUT_MS)));
          await Promise.race([q.interrupt(), late]).finally(() => clearTimeout(timer));
        } catch {
          interrupting = undefined;
          if (turns.between) settle();
          return false;
        }
        const sent = deliver(followUp, false);
        // The interrupted turn may have ended already (its result kept the run open for this).
        if (turns.between) interrupting = undefined;
        else if (sent) interruptFor = sent;
        if (!sent) settle();
        return sent !== false;
      };
      input.onSteer?.(Object.assign((followUp: FollowUp) => deliver(followUp, true) !== false, { status, interrupt }) satisfies Steer);

      const ends = () => ({ stderr, ...(rejectedUntil !== undefined ? { rejectedUntil } : {}), ...(apiError ? { apiError } : {}) });
      const q = query({ prompt: prompts, options });
      showThinking(q);
      let failed = true;
      try {
        for await (const msg of q) {
          lastEventAt = Date.now();
          background.observe(msg as Parameters<BackgroundAgents['observe']>[0]);
          watchQuiet();
          if (msg.type === 'system' && msg.subtype === 'init') remember(msg.session_id);
          if (msg.type === 'rate_limit_event') {
            const update = fromRateLimitEvent(msg.rate_limit_info);
            if (update) opts.bridge.reportUsage(update);
            if (msg.rate_limit_info.status === 'rejected') rejectedUntil = toMs(msg.rate_limit_info.resetsAt) ?? 0;
          }
          if (msg.type === 'assistant' && msg.error) apiError = msg.error;
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
            // A command's output that says how far it got (a test run polled in the background): its card shows "137/215".
            const count = progressCount(toolOutput(msg.message.content));
            if (count) turns.current().onEvent('progress', count);
            const content = msg.message.content;
            if (Array.isArray(content)) for (const block of content) if (block.type === 'tool_result') tools.delete(block.tool_use_id);
          }
          if (msg.type === 'result' || (msg.type === 'user' && msg.parent_tool_use_id === null)) thinking = false;
          if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
            const last = msg.message.content.at(-1)?.type;
            thinking = last === 'thinking' || last === 'redacted_thinking';
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                lastText = block.text.trim();
                route?.onEvent('text', lastText);
              }
              if (block.type === 'tool_use' && !subagents.isLaunch(block)) {
                const toolInput = (block.input ?? {}) as Record<string, unknown>;
                const label = summarizeTool(block.name, toolInput, cwd);
                tools.set(block.id, { label: block.name === 'Bash' && typeof toolInput.command === 'string' ? (toolInput.command.split('\n')[0] ?? '').slice(0, 80) : label, since: Date.now() });
                route?.onEvent('tool', label);
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
            // A turn that ended on an API error (a usage limit, an outage) is a failure, whatever its subtype.
            const ok = msg.subtype === 'success' && !msg.is_error;
            if (!ok) failedResult = msg.subtype === 'success' ? msg.result : [`Agent stopped: ${msg.subtype.replace(/_/g, ' ')}`, ...(msg.errors ?? [])].join('\n');
            const stopped = ok ? '' : new RunFailedError(classifyRun({ result: failedResult, ...ends() })).message;
            // The prompts this turn took in: a message steered in mid-turn is answered by it.
            const took = msg.user_message_uuids ?? (msg.user_message_uuid ? [msg.user_message_uuid] : undefined);
            tools.clear();
            const note = interrupting;
            if (note !== undefined) {
              // Interrupted for a message: the turn ends saying so, and the message's turn comes next.
              const said = msg.subtype === 'success' && msg.result ? `${msg.result}\n\n${note}` : note;
              turn.onEvent('text', note);
              // Its result can come after the message was sent and list it: the message still gets its own turn.
              const own = interruptFor;
              turns.end(true, said, own ? took?.filter((uuid) => uuid !== own) : took);
              if (turns.waiting) {
                interrupting = undefined;
                interruptFor = undefined;
              }
            }
            // A later turn failing (e.g. reporting a finished agent) doesn't throw away answers already given.
            else if (!turns.end(ok, ok ? (msg as { result: string }).result : stopped, took) && !turns.answers.length) throw new RunFailedError(classifyRun({ result: failedResult, ...ends() }));
            settle();
          }
        }
        failed = false;
      } catch (err) {
        if (err instanceof RunFailedError || abortController.signal.aborted) throw err;
        // Claude Code itself failed ("process exited with code 1"): say how, in words.
        throw new RunFailedError(classifyRun({ error: err instanceof Error ? err.message : String(err), ...(failedResult ? { result: failedResult } : {}), ...ends() }));
      } finally {
        recorder.finish(failed || abortController.signal.aborted);
        finish();
      }
      return turns.answers.join('\n\n');
    },

    nameTask: (prompt: string) => nameTask(prompt, { cwd: opts.cwd, claudePath: opts.claudePath }),
    answerChat: (req) => answerChat(req, { cwd: opts.cwd, ...(opts.claudePath ? { claudePath: opts.claudePath } : {}), ...(opts.model ? { model: opts.model } : {}) }),

    fixSetup: (dir: string, failed: string, output: string) => fixSetup(dir, failed, output, { claudePath: opts.claudePath }),
    draftTask: (text, ctx) => draftTask(text, ctx, { cwd: opts.cwd, ...(opts.claudePath ? { claudePath: opts.claudePath } : {}) }),

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
