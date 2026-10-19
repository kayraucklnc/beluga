import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StepRecord } from '../shared/steps.js';

/** Task types that are Claude working (not a background shell or a watcher). */
const AGENT_TASKS = new Set(['local_agent', 'local_workflow', 'remote_agent']);
const FINISHED = new Set(['completed', 'failed', 'killed', 'stopped']);

/**
 * The prompts of one live Claude Code session: the first request, then follow-ups sent while
 * its background agents are still working. Ending it lets Claude Code exit.
 */
/** What one prompt carries: plain text, or text plus content blocks (pasted images). */
export type PromptContent = SDKUserMessage['message']['content'];

export class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: PromptContent[] = [];
  private wake?: () => void;
  private ended = false;

  get closed(): boolean {
    return this.ended;
  }

  push(content: PromptContent): boolean {
    if (this.ended) return false;
    this.items.push(content);
    this.wake?.();
    return true;
  }

  close(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const content = this.items.shift();
      if (content !== undefined) {
        yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

interface TaskMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly task_id?: string;
  readonly task_type?: string;
  readonly status?: string;
  readonly patch?: { status?: string };
  readonly tasks?: ReadonlyArray<{ task_id: string; task_type: string; ambient?: boolean; parent_task_id?: string }>;
}

/**
 * Whether Claude still has background agents working, from the SDK stream. Prefers the
 * level signal (background_tasks_changed); falls back to task_started/finished edges.
 * A shell an agent started counts too (the agent picks its result up later); a shell the
 * main conversation left running (say, a dev server) doesn't keep the run open.
 */
export class BackgroundAgents {
  private live = new Set<string>();

  observe(msg: TaskMessage): void {
    if (msg.type !== 'system') return;
    if (msg.subtype === 'background_tasks_changed' && msg.tasks) {
      this.live = new Set(msg.tasks.filter((t) => !t.ambient && (AGENT_TASKS.has(t.task_type) || t.parent_task_id)).map((t) => t.task_id));
      return;
    }
    const id = msg.task_id;
    if (!id) return;
    if (msg.subtype === 'task_started' && msg.task_type && AGENT_TASKS.has(msg.task_type)) this.live.add(id);
    const status = msg.subtype === 'task_updated' ? msg.patch?.status : msg.subtype === 'task_notification' ? msg.status : undefined;
    if (status && FINISHED.has(status)) this.live.delete(id);
  }

  get busy(): boolean {
    return this.live.size > 0;
  }
}

type OnEvent = (kind: 'text' | 'tool' | 'sub' | 'context' | 'compact' | 'usage', text: string) => void;

/** Where one turn's output goes: the request that started the run, or a follow-up sent into it. */
export interface TurnRoute {
  readonly onEvent: OnEvent;
  /** Steps in detail (see AgentRunInput.onStep). */
  readonly onStep?: (record: StepRecord) => void;
  readonly onDone?: (final: string) => void;
  readonly onError?: (reason: string) => void;
}

/**
 * Sends each turn of a live session to the right request. Follow-ups take the next turns in
 * the order they were sent; turns Claude starts by itself (a background agent finished)
 * belong to the original request.
 */
export class TurnRouter {
  private readonly pending: TurnRoute[] = [];
  private active: TurnRoute;
  private inTurn = true;
  /** The original request's answers, one per turn of its own. */
  readonly answers: string[] = [];

  constructor(private readonly original: TurnRoute) {
    this.active = original;
  }

  /** The route for a main-thread message, opening a new turn after a result. */
  current(): TurnRoute {
    if (!this.inTurn) {
      this.active = this.pending.shift() ?? this.original;
      this.inTurn = true;
    }
    return this.active;
  }

  /** A turn ended. Returns false when the original request's own turn failed. */
  end(ok: boolean, text: string): boolean {
    const route = this.current();
    this.inTurn = false;
    if (route === this.original) {
      if (ok && text) {
        this.answers.push(text);
        // The first answer is what the asker waits for, even if background agents keep the run open.
        if (this.answers.length === 1) this.original.onDone?.(text);
      }
      return ok;
    }
    if (ok) route.onDone?.(text);
    else route.onError?.(text || 'Claude stopped before answering');
    return true;
  }

  queue(route: TurnRoute): void {
    this.pending.push(route);
  }

  /** Follow-ups sent but not answered yet. */
  get waiting(): boolean {
    return this.pending.length > 0 || (this.inTurn && this.active !== this.original);
  }

  /** Between turns: Claude has answered and isn't working on a new turn. */
  get between(): boolean {
    return !this.inTurn;
  }

  failPending(reason: string): void {
    const open = [...(this.inTurn && this.active !== this.original ? [this.active] : []), ...this.pending.splice(0)];
    for (const route of open) route.onError?.(reason);
  }
}
