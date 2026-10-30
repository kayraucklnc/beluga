import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import type { CodexConnect, CodexConnection } from './app-server.js';
import { handshake } from './app-server.js';
import { CodexRpc } from './rpc.js';

/** The words a scripted agent reads from a built prompt: its last line. */
export const scriptedWords = (prompt: string): string => prompt.trim().split('\n').at(-1)!.trim();

/**
 * A scripted `codex app-server` in memory, speaking its JSON-RPC (shapes as codex-cli 0.135's
 * generate-ts writes them, recorded from a real one), following the conformance script
 * (tests/runtime-conformance.ts): `P` is answered `echo: P` after running `echo P`; `ask…` asks
 * your approval first (declined: `denied: P`); `wait…` works until interrupted. Threads outlive a
 * connection, as Codex keeps them on disk, so a thread resumes in a later run. The conformance and
 * Codex tests drive it, and so does the demo (its Codex worktrees, for the Mac e2e: BLG-462).
 */
export class ScriptedCodex {
  /** `stepMs`: a pause before each step ends, so a screen sees it run (the demo); none in tests. */
  constructor(private readonly opts: { readonly stepMs?: number } = {}) {}

  /** Every request each app-server got, in order (for assertions). */
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly threads = new Set<string>();
  /** Answers for server requests Codex sends (approvals), by item. */
  readonly approvals: unknown[] = [];
  /** Set: a command step asks for approval before running (the prompt's words start with "ask"). */
  connections = 0;
  /** Signed in (account/read says who), or not. */
  signedIn = true;
  /** Its plan windows as the app-server says them (a signed-in Plus account's shape). */
  rateLimits: unknown = { limitId: 'codex', limitName: null, primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1780409235 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1780862132 }, credits: null, planType: 'plus', rateLimitReachedType: null };

  readonly connect: CodexConnect = async () => {
    this.connections++;
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const send = (msg: object): void => void (toClient.writable && toClient.write(`${JSON.stringify(msg)}\n`));
    const notify = (method: string, params: object): void => send({ method, params });
    let alive = true;
    let exit!: () => void;
    const exited = new Promise<void>((resolve) => (exit = resolve));
    let next = 1000;
    const asked = new Map<number, (result: unknown) => void>();
    const ask = (method: string, params: object): Promise<unknown> =>
      new Promise((resolve) => {
        const id = ++next;
        asked.set(id, resolve);
        send({ id, method, params });
      });
    /** The running turn: how to stop it. */
    let running: { id: string; threadId: string; stop: () => void } | undefined;

    const turn = async (threadId: string, turnId: string, text: string): Promise<void> => {
      const words = scriptedWords(text);
      const cmd = `cmd-${randomUUID()}`;
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', error: null, items: [] } });
      if (words.startsWith('fail')) return void notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Your access token could not be refreshed.', codexErrorInfo: 'unauthorized', additionalDetails: null }, items: [] } });
      notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: cmd, command: `/bin/zsh -lc 'echo ${words}'`, cwd: process.cwd(), status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null } });
      if (words.startsWith('edit')) {
        const item = { type: 'fileChange', id: `f-${turnId}`, status: 'inProgress', changes: [{ path: '/etc/hosts', kind: { type: 'update', move_path: null }, diff: '+x' }] };
        notify('item/started', { threadId, turnId, item });
        this.approvals.push(await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: item.id, reason: 'outside the workspace' }));
      }
      if (words.startsWith('ask')) {
        const verdict = (await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: cmd, command: `echo ${words}`, cwd: process.cwd() })) as { decision?: string } | undefined;
        this.approvals.push(verdict);
        // Declined: the command never runs, and Codex says so (as codex-cli does: the item ends `declined`).
        if (verdict?.decision === 'decline') {
          notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: cmd, command: `/bin/zsh -lc 'echo ${words}'`, cwd: process.cwd(), status: 'declined', aggregatedOutput: null, exitCode: null, durationMs: null } });
          notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `m-${turnId}`, text: `denied: ${words}`, phase: null } });
          notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, total: {}, modelContextWindow: null } });
          notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
          return;
        }
      }
      if (words.startsWith('wait')) {
        await new Promise<void>((resolve) => (running = { id: turnId, threadId, stop: resolve }));
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
        return;
      }
      if (this.opts.stepMs) await new Promise((resolve) => setTimeout(resolve, this.opts.stepMs));
      notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: cmd, command: `/bin/zsh -lc 'echo ${words}'`, cwd: process.cwd(), status: 'completed', aggregatedOutput: `${words}\n`, exitCode: 0, durationMs: 5 } });
      if (this.signedIn) notify('account/rateLimits/updated', { rateLimits: { ...(this.rateLimits as object), primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1780409235 } } });
      notify('item/completed', { threadId, turnId, item: { type: 'reasoning', id: `r-${turnId}`, summary: ['Saying it back.'], content: [] } });
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `m-${turnId}`, text: `echo: ${words}`, phase: null } });
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, total: {}, modelContextWindow: null } });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } });
    };

    const answer = (method: string, params: Record<string, unknown>): unknown => {
      switch (method) {
        case 'initialize':
          return { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
        case 'thread/start': {
          const id = randomUUID();
          this.threads.add(id);
          return { thread: { id }, model: 'gpt-fake' };
        }
        case 'thread/resume':
          if (!this.threads.has(String(params.threadId))) throw new Error('no rollout found');
          return { thread: { id: params.threadId }, model: 'gpt-fake' };
        case 'turn/start': {
          const id = randomUUID();
          const input = params.input as Array<{ type: string; text?: string }>;
          setImmediate(() => void turn(String(params.threadId), id, input.find((i) => i.type === 'text')?.text ?? ''));
          return { turn: { id, status: 'inProgress', error: null, items: [] } };
        }
        case 'turn/steer':
          if (running?.id !== params.expectedTurnId) throw new Error('no active turn');
          return { turnId: params.expectedTurnId };
        case 'turn/interrupt': {
          const stop = running?.id === params.turnId ? running?.stop : undefined;
          if (stop) setImmediate(stop);
          running = undefined;
          return {};
        }
        case 'account/read':
          return this.signedIn ? { account: { type: 'chatgpt', email: 'kay@example.com', planType: 'plus' }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true };
        case 'account/rateLimits/read':
          if (!this.signedIn) throw new Error('not signed in');
          return { rateLimits: this.rateLimits, rateLimitsByLimitId: null };
        case 'config/read':
          return { config: { mcp_servers: { figma: { url: 'https://figma.example' } } }, origins: {} };
        case 'model/list':
          return { data: [{ id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Frontier', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null };
        default:
          throw new Error(`unknown method ${method}`);
      }
    };

    readline.createInterface({ input: toServer }).on('line', (line) => {
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (!msg.method && msg.id !== undefined) return void asked.get(msg.id)?.(msg.result);
      if (!msg.method) return;
      this.requests.push({ method: msg.method, params: msg.params ?? {} });
      if (msg.id === undefined) return;
      try {
        send({ id: msg.id, result: answer(msg.method, msg.params ?? {}) });
      } catch (err) {
        send({ id: msg.id, error: { code: -32600, message: (err as Error).message } });
      }
    });

    const rpc = new CodexRpc(toClient, toServer);
    const conn: CodexConnection = {
      rpc,
      stderr: () => [],
      proc: {
        pid: 4242,
        alive: () => alive,
        exited,
        kill: async () => {
          if (!alive) return;
          alive = false;
          running?.stop();
          toClient.end();
          toServer.end();
          exit();
        },
      },
    };
    await handshake(rpc);
    return conn;
  };

  /** The params of every request of `method`. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}
