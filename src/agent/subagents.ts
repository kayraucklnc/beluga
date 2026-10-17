import { summarizeTool } from './prompt.js';
import type { SubAgentEvent } from './types.js';

/** Tools that launch a sub-agent in Claude Code. */
export const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

interface Block {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
}

/**
 * Follows sub-agents through the SDK message stream: a top-level Task/Agent tool
 * call starts one, messages tagged with its id are its steps, and the matching
 * tool_result ends it.
 */
export class SubAgentTracker {
  private readonly open = new Set<string>();
  private readonly tasks = new Set<string>();

  constructor(private readonly cwd?: string) {}

  /** Returns true if the tool_use is a sub-agent launch (so callers can skip it as a normal step). */
  isLaunch(block: Block): boolean {
    return block.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name ?? '');
  }

  assistant(parentToolUseId: string | null, blocks: readonly Block[]): SubAgentEvent[] {
    const events: SubAgentEvent[] = [];
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (parentToolUseId === null && this.isLaunch(block) && block.id) {
        this.open.add(block.id);
        const title = [input.subagent_type, input.description].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' · ');
        events.push({ id: block.id, phase: 'start', title: title || 'sub-agent' });
      } else if (parentToolUseId && this.open.has(parentToolUseId)) {
        events.push({ id: parentToolUseId, phase: 'step', step: summarizeTool(block.name ?? 'tool', input, this.cwd) });
      }
    }
    return events;
  }

  /**
   * Background work Claude Code reports as tasks (background shells, background agents).
   * Tasks that belong to a sub-agent we already show are skipped.
   */
  task(msg: { subtype?: string; task_id?: string; tool_use_id?: string; description?: string; patch?: { status?: string; description?: string }; status?: string; summary?: string }): SubAgentEvent[] {
    const id = msg.task_id;
    if (!id || (msg.tool_use_id && this.open.has(msg.tool_use_id))) return [];
    if (msg.subtype === 'task_started') {
      this.tasks.add(id);
      return [{ id, phase: 'start', title: msg.description || 'background task', kind: 'background' }];
    }
    if (!this.tasks.has(id)) return [];
    if (msg.subtype === 'task_progress' && msg.description) return [{ id, phase: 'step', step: msg.description }];
    const status = msg.subtype === 'task_updated' ? msg.patch?.status : msg.subtype === 'task_notification' ? msg.status : undefined;
    if (status && ['completed', 'failed', 'killed', 'stopped'].includes(status)) {
      this.tasks.delete(id);
      return [{ id, phase: 'done', failed: status !== 'completed', ...(msg.summary ? { step: msg.summary } : {}) }];
    }
    return [];
  }

  user(blocks: readonly Block[] | string): SubAgentEvent[] {
    if (typeof blocks === 'string') return [];
    const events: SubAgentEvent[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_result' && block.tool_use_id && this.open.delete(block.tool_use_id)) {
        events.push({ id: block.tool_use_id, phase: 'done' });
      }
    }
    return events;
  }
}
