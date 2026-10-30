import path from 'node:path';
import { linkedImages } from '../../../core/attachments.js';
import { type RunEnd, RunFailedError, classifyRun } from '../../../shared/run-failure.js';
import { fallbackFor } from '../../../shared/runtime-fallbacks.js';
import { buildPrompt } from '../../prompt.js';
import { runInstructions } from '../../run-instructions.js';
import { runToolSuites } from '../../run-tools.js';
import { ToolHost, type StdioServerConfig } from '../../tool-host.js';
import { gateTool } from '../../tool-gate.js';
import { sideCalls } from '../../side-calls.js';
import { syncProbes } from '../../sync-main.js';
import type { AgentBackend, AgentRunInput, FollowUp, LiveStatus, RoomBridge, Steer } from '../../types.js';
import { ViewShelf } from '../../view-tools.js';
import { INTERRUPT_TIMEOUT_MS } from '../types.js';
import { type CodexConnect, type CodexConnection, spawnAppServer } from './app-server.js';
import { codexComplete } from './complete.js';
import { CodexEvents, type TurnSink, usageEvent } from './events.js';
import type { AskForApproval, Model, ReasoningEffort, ThreadStartResponse, Turn, UserInput } from './protocol.js';
import { codexConfinement, originOf, trustRow } from './sandbox.js';
import { CODEX_USAGE_AGENT, type CodexRateLimits, fromRateLimits } from './rate-limits.js';
import { findCodex } from './app-server.js';
import { type MappedPrompt, mapSlash } from './skills.js';
import { claudeHome } from '../../../core/claude-code/launch.js';

export interface CodexBackendOptions {
  readonly cwd: string;
  readonly autoEdit: boolean;
  readonly additionalDirectories: readonly string[];
  readonly bridge: RoomBridge;
  readonly model?: string;
  /** Codex's executable; unset: findCodex(). */
  readonly codexPath?: string;
  /** How to reach an app-server (tests: a scripted one). */
  readonly connect?: CodexConnect;
  /** Where Beluga's tools are served to the run over stdio (one per daemon). */
  readonly toolHost?: ToolHost;
}

const CODEX_AGENT = { runtime: 'codex', label: 'Codex' } as const;
const MODEL_TIMEOUT_MS = 20_000;
/** A plan sent back for changes this many times: the run ends with the last plan as its answer. */
const PLAN_ROUNDS = 5;

let sharedHost: ToolHost | undefined;
const toolHost = (): ToolHost => (sharedHost ??= new ToolHost());

/** A model Codex knows, or undefined for its own default (Claude's aliases mean nothing to it). */
export function codexModel(model: string | undefined): string | undefined {
  if (!model || /^(default|haiku|sonnet|opus|claude|fable)/i.test(model)) return undefined;
  return model;
}

/** Beluga's effort names as Codex's ('max' is Codex's 'xhigh'). */
export function codexEffort(effort: AgentRunInput['effort']): ReasoningEffort | undefined {
  return effort === 'max' ? 'xhigh' : effort;
}

/** Beluga's tool servers as Codex config overrides (`mcp_servers.<name>`), for one thread. */
export function mcpConfig(servers: Readonly<Record<string, StdioServerConfig>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(servers).map(([name, s]) => [`mcp_servers.${name}`, { command: s.command, args: s.args, env: s.env }]));
}

/** A prompt as Codex's input: the text, and images it links (Codex reads them from disk). */
export function codexInput(text: string, prompt: string, skill?: MappedPrompt['skill']): UserInput[] {
  return [{ type: 'text', text, text_elements: [] }, ...linkedImages(prompt).map((file) => ({ type: 'localImage' as const, path: file })), ...(skill ? [{ type: 'skill' as const, ...skill }] : [])];
}

/** Friendly rows for the model picker from Codex's own list. */
export function toCodexModelChoices(models: readonly Model[]) {
  return models
    .filter((m) => !m.hidden)
    .map((m) => ({ value: m.isDefault ? '' : m.id, label: m.displayName, description: m.description, efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort) }));
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

/**
 * Runs turns on Codex through `codex app-server` (BLG-453): one app-server per run, one thread per
 * place (its id is the place's session, so the conversation resumes), each request a turn, its
 * items streamed into onEvent/onStep the way Claude's are. Beluga's tools reach it as stdio MCP
 * servers (agent/tool-host.ts), gated per call like Claude's. Codex's own steps are confined by
 * its sandbox (see sandbox.ts); when it asks to go further, you're asked through canUseTool.
 */
export function createCodexBackend(opts: CodexBackendOptions): AgentBackend {
  let sessionId: string | undefined;
  const connect = opts.connect ?? spawnAppServer;
  const host = (): ToolHost => opts.toolHost ?? toolHost();

  return {
    async run(input: AgentRunInput): Promise<string> {
      if (input.signal.aborted) throw new Error('aborted');
      const bridge = input.channel && opts.bridge.inChannel ? opts.bridge.inChannel(input.channel) : opts.bridge;
      const place = input.place;
      const cwd = place?.cwd ?? opts.cwd;
      const extraDirs = place ? place.additionalDirectories : opts.additionalDirectories;
      const askOnly = place?.askOnly;
      const autoEdit = !askOnly && (place?.autoEdit ?? opts.autoEdit);
      const fixup = place?.fixup;
      const syncMain = askOnly ? place?.syncMain : undefined;
      const policy = { cwd, roots: [cwd, ...extraDirs, ...(fixup ? [fixup] : [])], autoEdit, scope: input.scope, guest: input.guest, dotenv: Boolean(input.canUseSecret) && !input.guest, askOnly: Boolean(askOnly), ...(syncMain ? { syncMain: syncProbes(cwd, syncMain) } : {}), ...(fixup ? { fixup } : {}) };
      const remember = (id: string): void => (place ? place.onSession(id) : void (sessionId = id));
      const shelf = new ViewShelf();
      const model = codexModel(input.model ?? place?.model ?? opts.model);
      const effort = codexEffort(input.effort);

      // Beluga's tools, served for this run alone and gated per call (vetTool, policy, you).
      const mounted = await host().mount(runToolSuites(input, bridge, shelf, cwd), (name, args) => gateTool(name, args, input, policy));
      let conn: CodexConnection | undefined;
      const events = new CodexEvents(cwd, { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) }, { onFileTouched: input.onFileTouched, expand: (t) => shelf.expand(t) });
      let failed = true;
      let closed = false;
      try {
        // Turns: the one running now, and how each ended (one can end before turn/start answers).
        let active: { id?: string; readonly done: ReturnType<typeof deferred<Turn>> } | undefined;
        const ended = new Map<string, Turn>();
        /** Rejects when the app-server behind the run goes away on its own. */
        let stopped = deferred<never>();
        const origin = originOf(input);

        /**
         * An app-server with this run's thread on it, confined for `planning` or for work (see
         * sandbox.ts). Planning, then working, reopens the thread: a thread's sandbox is set when
         * it's opened, never by a turn, so the work isn't done under the plan's read-only one.
         */
        const open = async (planning: boolean, resume: string | undefined): Promise<string> => {
          const link = await connect({ cwd, env: { ...process.env, ...input.env }, ...(opts.codexPath ? { bin: opts.codexPath } : {}) });
          conn = link;
          const { rpc } = link;
          input.onProcess?.(link.proc);
          const gone = deferred<never>();
          stopped = gone;
          rpc.onNotification((method, params) => {
            events.handle(method, params);
            // Codex's plan windows as they move (BLG-474): filed under Codex, never Claude.
            if (method === 'account/rateLimits/updated') reportLimits(bridge, params.rateLimits as CodexRateLimits);
            if (method === 'turn/started' && active && !active.id) active.id = (params.turn as Turn).id;
            if (method === 'turn/completed') {
              const turn = params.turn as Turn;
              if (active?.id === turn.id) active.done.resolve(turn);
              else ended.set(turn.id, turn);
            }
          });
          void rpc.closed.then(() => {
            if (!closed && conn === link) gone.reject(codexFailure({ error: 'Codex exited before the turn ended', stderr: link.stderr() }));
          });
          // Codex asking to go past its sandbox (your own runs only): the same gate as every other tool, so you decide.
          rpc.onRequest(async (method, params) => {
            if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
              const command = typeof params.command === 'string' ? params.command : Array.isArray(params.command) ? params.command.join(' ') : '';
              const denied = await gateTool('Bash', { command, ...(params.reason ? { description: params.reason } : {}) }, input, policy);
              return { decision: denied ? 'decline' : 'accept' };
            }
            if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
              const changes = events.changes.get(String(params.itemId)) ?? [];
              const files = changes.length ? changes.map((c) => path.resolve(cwd, c.path)) : [typeof params.grantRoot === 'string' ? params.grantRoot : cwd];
              for (const file of files) if (await gateTool('Edit', { file_path: file }, input, policy)) return { decision: 'decline' };
              return { decision: 'accept' };
            }
            // Anything else (more permissions, questions, elicitations) isn't Beluga's to grant.
            throw new Error(`${method} isn’t supported in Beluga`);
          });
          // A friend's task gets none of your own Codex MCP servers: their names, to switch them off.
          const yourServers = trustRow(origin, input.scope).yourTools ? [] : await rpc.request<{ config?: { mcp_servers?: Record<string, unknown> } }>('config/read', {}).then((r) => Object.keys(r.config?.mcp_servers ?? {}), () => []);
          const writableRoots = planning || !autoEdit ? (fixup ? [fixup] : []) : [cwd, ...extraDirs, ...(fixup ? [fixup] : [])];
          const confined = codexConfinement(origin, input.scope, { cwd, folders: [...extraDirs, ...(fixup ? [fixup] : [])], writable: writableRoots, yourServers });
          approval = confined.approval;
          const params = { cwd, ...(model ? { model } : {}), developerInstructions: runInstructions(input, opts.bridge.selfName(), CODEX_AGENT), config: { ...confined.config, ...PROJECT_DOCS, ...mcpConfig(mounted.servers) }, approvalPolicy: confined.approval };
          let thread: ThreadStartResponse | undefined;
          if (resume) {
            thread = await rpc.request<ThreadStartResponse>('thread/resume', { threadId: resume, ...params }).catch(() => undefined);
            if (!thread) input.onEvent('progress', 'Started a new Codex conversation (the last one couldn’t be opened)');
          }
          thread ??= await rpc.request<ThreadStartResponse>('thread/start', params);
          // Where its windows stand now, without waiting for the turn to move them.
          void readLimits(rpc).then((limits) => reportLimits(bridge, limits));
          return thread.thread.id;
        };
        let approval: AskForApproval = 'never';
        // A fork can't branch a Codex thread (canFork: false): resuming it would write into the source's
        // own conversation, so a fork starts a new one, and says so (BLG-461).
        const forked = Boolean(place?.forkSession && place.resume);
        if (forked) input.onEvent('progress', fallbackFor('codex', 'fork')!);
        let threadId = await open(Boolean(input.plan), place ? (forked ? undefined : place.resume) : sessionId);
        remember(threadId);
        if (input.signal.aborted) throw new Error('aborted');
        const rpc = () => conn!.rpc;

        // Stop: interrupt the turn (same contract as Claude), then the process for sure.
        let aborted = false;
        const abort = deferred<never>();
        const onAbort = (): void => {
          aborted = true;
          void interruptTurn().finally(() => {
            abort.reject(new Error('aborted'));
            void conn?.proc.kill();
          });
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) throw new Error('aborted');

        /** Ask Codex to stop the running turn; true once it has, within INTERRUPT_TIMEOUT_MS. */
        const interruptTurn = async (): Promise<boolean> => {
          const turn = active;
          if (!turn) return false;
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS)));
          const stop = (async () => {
            while (!turn.id) await new Promise((r) => setTimeout(r, 20));
            await rpc().request('turn/interrupt', { threadId, turnId: turn.id });
            await turn.done.promise;
            return true;
          })().catch(() => false);
          return Promise.race([stop, late]).finally(() => clearTimeout(timer));
        };

        /** One turn: its answer's text, how it ended. */
        const runTurn = async (sink: TurnSink, text: string, prompt: string, skill?: MappedPrompt['skill']): Promise<{ text: string; turn: Turn }> => {
          events.beginTurn(sink);
          const done = deferred<Turn>();
          active = { done };
          // No sandboxPolicy here: a turn's would replace the thread's profile (and its .env denials).
          const res = await rpc().request<{ turn: Turn }>('turn/start', { threadId, input: codexInput(text, prompt, skill), approvalPolicy: approval, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
          active.id ??= res.turn.id;
          const early = ended.get(res.turn.id);
          if (early) done.resolve(early);
          try {
            const turn = await Promise.race([done.promise, stopped.promise, abort.promise]);
            const said = events.endTurn(turn.status === 'completed');
            if (said.usage) sink.onEvent('usage', usageEvent(said.usage, threadId));
            return { text: said.text, turn };
          } finally {
            active = undefined;
          }
        };

        // Messages for the run: steered in while a turn works, or a turn of their own after it.
        const pending: FollowUp[] = [];
        /** Steers Codex hasn't answered yet: one it turns down still gets a turn of its own. */
        const inflight = new Set<Promise<unknown>>();
        let interrupting: string | undefined;
        const steerIn = (followUp: FollowUp): boolean => {
          const turn = active;
          if (closed || !turn?.id) return false;
          const sent = rpc()
            .request('turn/steer', { threadId, input: codexInput(buildPrompt(followUp), followUp.prompt), expectedTurnId: turn.id })
            .then(
              () => followUp.onFolded?.(),
              // The turn ended first: the message gets a turn of its own.
              () => (closed ? followUp.onError('Codex finished before getting to this message') : void pending.push(followUp)),
            )
            .finally(() => inflight.delete(sent));
          inflight.add(sent);
          return true;
        };
        const status = (): LiveStatus => {
          const tool = [...events.tools.values()].sort((a, b) => a.since - b.since)[0];
          return { ...(tool ? { tool } : {}), lastEventAt: events.lastEventAt, between: !active, ...(events.thinking ? { thinking: true } : {}), alive: conn?.proc.alive() ?? false };
        };
        const interrupt = async (followUp: FollowUp, note: string): Promise<boolean> => {
          if (closed || !active || interrupting !== undefined) return false;
          interrupting = note;
          pending.unshift(followUp);
          const ok = await interruptTurn();
          if (!ok) {
            const at = pending.indexOf(followUp);
            if (at !== -1) pending.splice(at, 1);
            interrupting = undefined;
          }
          return ok;
        };
        input.onSteer?.(Object.assign(steerIn, { status, interrupt }) satisfies Steer);

        const original: TurnSink = { onEvent: input.onEvent, ...(input.onStep ? { onStep: input.onStep } : {}) };
        /** A turn's end as its answer: an interrupted one ends with the note it was stopped with. */
        const answerOf = (r: { text: string; turn: Turn }, sink: TurnSink): string => {
          if (r.turn.status === 'interrupted' && interrupting !== undefined) {
            const note = interrupting;
            interrupting = undefined;
            sink.onEvent('text', note);
            return r.text ? `${shelf.finish(r.text)}\n\n${note}` : note;
          }
          if (r.turn.status === 'failed') throw codexFailure({ result: `${r.turn.error?.message ?? 'Codex stopped'}${r.turn.error?.codexErrorInfo === 'unauthorized' ? SIGN_IN : ''}`, ...(r.turn.error?.additionalDetails ? { error: r.turn.error.additionalDetails } : {}), stderr: conn?.stderr() ?? [] });
          if (r.turn.status === 'interrupted') throw new Error('aborted');
          return shelf.finish(r.text);
        };

        /** What didn't map to Codex, said in the chat now and kept at the top of the answer. */
        const noted = (m: MappedPrompt, sink: TurnSink): ((answer: string) => string) => {
          for (const note of m.notes) sink.onEvent('text', note);
          return (answer) => (m.notes.length ? `${m.notes.join('\n')}\n\n${answer}` : answer);
        };
        const answers: string[] = [];
        // Plan mode, the Codex way: a read-only turn that answers with a plan, for you to approve.
        // `/name`: one of Claude Code's skills or commands, mapped to Codex (what doesn't map is said, see skills.ts).
        const mapped = await mapSlash(input.prompt, cwd, claudeHome());
        const said = noted(mapped, original);
        const asked = buildPrompt({ ...input, prompt: mapped.prompt });
        let r = await runTurn(original, input.plan ? `${asked}\n\n${PLAN_NOTE}` : asked, input.prompt, mapped.skill);
        let answer = said(answerOf(r, original));
        for (let round = 0; input.plan && input.askUser && round < PLAN_ROUNDS && r.turn.status === 'completed'; round++) {
          const verdict = await input.askUser({ kind: 'plan', plan: (r.text || '(Codex proposed a plan)').slice(0, 60_000) });
          if (verdict.kind !== 'plan') break;
          if (verdict.approve) input.planTask?.approved();
          const next = verdict.approve ? 'The plan is approved. Do the work now.' : verdict.feedback ? `Change the plan: ${verdict.feedback}\n\n${PLAN_NOTE}` : undefined;
          if (!next) break;
          // Approved: the thread is reopened confined for work.
          if (verdict.approve) {
            const planned = conn;
            threadId = await open(false, threadId);
            await planned?.proc.kill();
          }
          r = await runTurn(original, next, '');
          answer = said(answerOf(r, original));
          if (verdict.approve) break;
        }
        answers.push(answer);
        input.onAnswered?.(answer);

        // Then each message that waits for a turn of its own.
        while (!aborted) {
          const followUp = pending.shift();
          if (!followUp) {
            if (!inflight.size) break;
            await Promise.allSettled([...inflight]);
            continue;
          }
          const sink: TurnSink = { onEvent: followUp.onEvent, ...(followUp.onStep ? { onStep: followUp.onStep } : {}) };
          followUp.onStart?.();
          try {
            const its = await mapSlash(followUp.prompt, cwd, claudeHome());
            const note = noted(its, sink);
            followUp.onDone(note(answerOf(await runTurn(sink, buildPrompt({ ...followUp, prompt: its.prompt }), followUp.prompt, its.skill), sink)));
          } catch (err) {
            if (aborted) throw err;
            followUp.onError(err instanceof Error ? err.message : String(err));
          }
        }
        for (const left of pending.splice(0)) left.onError('Codex finished before getting to this message');
        input.signal.removeEventListener('abort', onAbort);
        failed = false;
        return answers.join('\n\n');
      } finally {
        closed = true;
        input.onSteer?.(undefined);
        events.finish(failed || input.signal.aborted);
        mounted.close();
        await conn?.proc.kill();
      }
    },

    // Side calls (naming, drafting, chat answers…) through Codex's one-shot call.
    ...sideCalls((req) => codexComplete(req, { connect, ...(opts.codexPath ? { bin: opts.codexPath } : {}) }), opts.cwd, opts.model),

    // Codex's plan windows without a run (the usage tab): reported for Codex, so nothing is filed as Claude's.
    async refreshUsage() {
      if (!opts.connect && !opts.codexPath && !findCodex()) return undefined;
      const conn = await connect({ cwd: opts.cwd, ...(opts.codexPath ? { bin: opts.codexPath } : {}) }).catch(() => undefined);
      if (!conn) return undefined;
      try {
        reportLimits(opts.bridge, await readLimits(conn.rpc));
      } finally {
        await conn.proc.kill();
      }
      return undefined;
    },

    async listModels() {
      const conn = await connect({ cwd: opts.cwd, ...(opts.codexPath ? { bin: opts.codexPath } : {}) }).catch(() => undefined);
      if (!conn) return undefined;
      try {
        const res = await conn.rpc.request<{ data: Model[] }>('model/list', {}, MODEL_TIMEOUT_MS);
        return toCodexModelChoices(res.data);
      } catch {
        return undefined;
      } finally {
        await conn.proc.kill();
      }
    },
  };
}

/** Codex's windows now (`account/rateLimits/read`); undefined when it can't say (signed out, an API key). */
async function readLimits(rpc: CodexConnection['rpc']): Promise<CodexRateLimits | undefined> {
  const res = await rpc.request<{ rateLimits?: CodexRateLimits | null }>('account/rateLimits/read', {}, MODEL_TIMEOUT_MS).catch(() => undefined);
  return res?.rateLimits ?? undefined;
}

/** Codex's windows into its own usage card (the bridge files them under Codex). */
function reportLimits(bridge: RoomBridge, limits: CodexRateLimits | undefined): void {
  const update = fromRateLimits(limits);
  if (update) bridge.reportUsage({ ...update, signedIn: true }, CODEX_USAGE_AGENT);
}

/** A project's instructions: Codex reads AGENTS.md itself, and CLAUDE.md where a project has only that. */
const PROJECT_DOCS = { project_doc_fallback_filenames: ['CLAUDE.md'] };

/** A failed Codex run, told as Codex's (not Claude Code's). */
const codexFailure = (end: RunEnd): RunFailedError => new RunFailedError({ ...classifyRun(end), runtime: 'codex' });
const SIGN_IN = ' Sign in to Codex again (`codex login`), then resend.';

const PLAN_NOTE = 'Plan only: look around read-only, change nothing, and answer with a step-by-step plan for the person to approve.';
