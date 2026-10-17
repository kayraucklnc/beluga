import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import type { LogItem } from '../core/store.js';
import { summarizeTool } from './prompt.js';

/** What a Claude Code transcript entry looks like (only the parts we read). */
export interface TranscriptMessage {
  readonly type: 'user' | 'assistant' | 'system';
  readonly message: unknown;
  readonly parent_tool_use_id: string | null;
}

export interface Conversation {
  readonly sessionId: string;
  readonly title: string;
  readonly lastModified: number;
  readonly items: LogItem[];
}

const MAX_ITEMS = 200;
const MAX_STEPS = 40;
const SUMMARY_CHARS = 1200;
const CONTINUED = 'This session is being continued from a previous conversation';
/** Lines Claude Code adds itself (slash commands, hooks, reminders): not something you typed. */
const MACHINE = /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook|bash-|task-notification)/;

type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
};

/**
 * Turn a Claude Code conversation into klaud's chat: your messages, and one Claude card
 * per turn with its steps and final words. Sub-agent chatter and tool output are left out.
 */
export function transcriptToLog(messages: readonly TranscriptMessage[], opts: { selfId: string; selfName: string; cwd: string; start: number; end: number }): LogItem[] {
  const items: LogItem[] = [];
  const span = Math.max(1, messages.length);
  const tsAt = (i: number): number => Math.round(opts.start + ((opts.end - opts.start) * i) / span);
  let turn: { id: string; text: string; steps: string[]; ts: number; endTs: number } | undefined;
  const flush = (): void => {
    if (!turn || (!turn.text && !turn.steps.length)) return;
    items.push({
      id: turn.id,
      type: 'agent',
      channel: '',
      subagents: [],
      requestId: turn.id,
      owner: opts.selfId,
      ownerName: opts.selfName,
      requesterName: opts.selfName,
      status: 'done',
      text: turn.text || '(worked without a written answer)',
      steps: turn.steps.slice(-MAX_STEPS),
      ts: turn.ts,
      endTs: turn.endTs,
    });
    turn = undefined;
  };
  messages.forEach((m, i) => {
    if (m.parent_tool_use_id) return; // inside a sub-agent
    const ts = tsAt(i);
    if (m.type === 'user') {
      const text = blocksOf(m.message)
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      if (!text) return;
      flush(); // a new message (yours, or a background task reporting back) starts Claude's next turn
      if (MACHINE.test(text)) return;
      if (text.startsWith(CONTINUED)) {
        const summary = text.slice(text.indexOf('Summary:') >= 0 ? text.indexOf('Summary:') + 8 : 0).trim();
        const short = summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS).trimEnd()}…` : summary;
        items.push({ id: `t-${i}`, type: 'system', channel: '', text: `Earlier in this conversation (summarized):\n${short}`, ts, level: 'info' });
        return;
      }
      items.push({ id: `t-${i}`, type: 'chat', channel: '', from: opts.selfId, name: opts.selfName, text, ts, byAgent: false });
      return;
    }
    if (m.type !== 'assistant') return;
    // Claude Code's own notices (rate limits, API errors) aren't Claude's words.
    if ((m.message as { model?: string } | undefined)?.model === '<synthetic>') return;
    turn ??= { id: `t-${i}`, text: '', steps: [], ts, endTs: ts };
    turn.endTs = ts;
    for (const b of blocksOf(m.message)) {
      if (b.type === 'text' && b.text?.trim()) turn.text = b.text.trim();
      if (b.type === 'tool_use' && b.name) turn.steps.push(summarizeTool(b.name, b.input ?? {}, opts.cwd));
    }
  });
  flush();
  return items.slice(-MAX_ITEMS);
}

/**
 * The latest Claude Code conversation that ran in exactly this folder (e.g. a worktree
 * made by Conductor or by Claude Code itself), ready to show and to continue.
 */
export async function findConversation(dir: string, self: { id: string; name: string }): Promise<Conversation | undefined> {
  const sessions = await listSessions({ dir, includeWorktrees: false, limit: 10 });
  const latest = sessions.filter((s) => !s.cwd || s.cwd === dir).sort((a, b) => b.lastModified - a.lastModified)[0];
  if (!latest) return undefined;
  const messages = (await getSessionMessages(latest.sessionId, { dir })) as TranscriptMessage[];
  const items = transcriptToLog(messages, { selfId: self.id, selfName: self.name, cwd: dir, start: latest.createdAt ?? latest.lastModified, end: latest.lastModified });
  return { sessionId: latest.sessionId, title: latest.customTitle ?? latest.summary, lastModified: latest.lastModified, items };
}
