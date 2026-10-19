import type { LogItem } from '../core/store.js';
import { type StepRecord, boundInput, boundText, redactSecrets, resultText, thinkingOf, thinkingTitle, wordsOf } from '../shared/steps.js';
import { summarizeTool } from './prompt.js';

/**
 * Claude Code transcripts → klaud's chat. Pure: no files, no SDK (reading the files is
 * claude-sessions.ts), so anything that shows Claude Code conversations can reuse it.
 */

/** What a Claude Code transcript entry looks like (only the parts we read). */
export interface TranscriptMessage {
  readonly type: 'user' | 'assistant' | 'system';
  readonly message: unknown;
  readonly parent_tool_use_id: string | null;
}

/** One Claude Code conversation in a folder, without its messages (for lists and pickers). */
export interface ConversationSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly lastModified: number;
  readonly createdAt?: number;
}

export interface Conversation extends ConversationSummary {
  readonly items: LogItem[];
  /** Each Claude turn's steps in detail, by its item's id (opened from its card; kept on this computer). */
  readonly steps?: Readonly<Record<string, readonly StepRecord[]>>;
  /** Every conversation in that folder, newest first (this one included). */
  readonly all?: readonly ConversationSummary[];
}

const MAX_ITEMS = 200;
const MAX_STEPS = 40;
/** Detailed steps kept per imported turn. */
const MAX_TURN_RECORDS = 200;
const SUMMARY_CHARS = 1200;
const CONTINUED = 'This session is being continued from a previous conversation';
/** Lines Claude Code adds itself (slash commands, hooks, reminders): not something you typed. */
const MACHINE = /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook|bash-|task-notification)/;
/** Claude Code's own markers when you stop it ("[Request interrupted by user]"). */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
/** Instructions a tool wraps around what you typed (Conductor adds its own in <system_instruction>). */
const WRAPPERS = /<(system_instruction|system-instruction)>[\s\S]*?<\/\1>/g;

type Block = { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean; thinking?: unknown };
const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
};

/** What you typed in a user entry, without the instructions tools wrap around it. */
export function typedText(message: unknown): string {
  return blocksOf(message)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .replace(WRAPPERS, '')
    .trim();
}

type TranscriptOptions = { selfId: string; selfName: string; cwd: string; start: number; end: number };

/**
 * Turn a Claude Code conversation into klaud's chat: your messages, and one Claude card
 * per turn with its steps (tool calls, in words) and final words. Sub-agent chatter and
 * tool output are left out.
 */
export function transcriptToLog(messages: readonly TranscriptMessage[], opts: TranscriptOptions): LogItem[] {
  return transcriptToTurns(messages, opts).items;
}

/**
 * The chat (see transcriptToLog) plus each Claude turn's steps in detail: every tool call with
 * its input and result, and Claude's thinking (when the transcript has its words), the same
 * records a run in klaud keeps (shared/steps.ts). Times are spread over the conversation, so
 * no durations are claimed.
 */
export function transcriptToTurns(messages: readonly TranscriptMessage[], opts: TranscriptOptions): { items: LogItem[]; steps: Record<string, StepRecord[]> } {
  const items: LogItem[] = [];
  const steps: Record<string, StepRecord[]> = {};
  const span = Math.max(1, messages.length);
  const tsAt = (i: number): number => Math.round(opts.start + ((opts.end - opts.start) * i) / span);
  let turn: { id: string; text: string; steps: string[]; records: StepRecord[]; ts: number; endTs: number } | undefined;
  /** Tool calls waiting for their results: which turn and which record. */
  const open = new Map<string, { records: StepRecord[]; at: number }>();
  let thoughts = 0;
  const settle = (b: Block): void => {
    const where = b.tool_use_id ? open.get(b.tool_use_id) : undefined;
    if (!where) return;
    open.delete(b.tool_use_id!);
    const rec = where.records[where.at]!;
    const out = boundText(redactSecrets(resultText(b.content)));
    const error = b.is_error === true;
    where.records[where.at] = { ...rec, status: error ? 'error' : 'done', output: out.text, ...(error ? { isError: true } : {}), ...(out.truncated || rec.truncated ? { truncated: true } : {}) };
  };
  const flush = (): void => {
    if (turn?.records.length && (turn.text || turn.steps.length)) steps[turn.id] = turn.records.map((r) => (r.status === 'running' ? { ...r, status: 'done' as const } : r));
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
      for (const b of blocksOf(m.message)) if (b.type === 'tool_result') settle(b);
      const text = typedText(m.message);
      if (!text) return;
      flush(); // a new message (yours, or a background task reporting back) starts Claude's next turn
      if (MACHINE.test(text) || INTERRUPTED.test(text)) return;
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
    turn ??= { id: `t-${i}`, text: '', steps: [], records: [], ts, endTs: ts };
    turn.endTs = ts;
    for (const b of blocksOf(m.message)) {
      if (b.type === 'text' && b.text?.trim()) turn.text = b.text.trim();
      if (b.type === 'tool_use' && b.name) {
        const title = summarizeTool(b.name, b.input ?? {}, opts.cwd);
        turn.steps.push(title);
        if (turn.records.length >= MAX_TURN_RECORDS) continue;
        const { input, truncated } = boundInput(b.input ?? {});
        const id = b.id ?? `tool-${i}-${turn.records.length}`;
        if (b.id) open.set(b.id, { records: turn.records, at: turn.records.length });
        turn.records.push({ id, kind: 'tool', tool: b.name, title: redactSecrets(title), ...wordsOf(b.name, b.input ?? {}, opts.cwd), status: 'running', startedAt: ts, input, ...(truncated ? { truncated: true } : {}) });
      }
      if ((b.type === 'thinking' || b.type === 'redacted_thinking') && turn.records.length < MAX_TURN_RECORDS) {
        const t = b.type === 'thinking' ? thinkingOf(b) : { text: '', hidden: true, truncated: false };
        turn.records.push({ id: `think-${++thoughts}`, kind: 'thinking', title: thinkingTitle(undefined, t.hidden), status: 'done', startedAt: ts, ...(t.hidden ? { hidden: true } : { text: t.text }), ...(t.truncated ? { truncated: true } : {}) });
      }
    }
  });
  flush();
  const kept = items.slice(-MAX_ITEMS);
  const ids = new Set(kept.map((it) => it.id));
  return { items: kept, steps: Object.fromEntries(Object.entries(steps).filter(([id]) => ids.has(id))) };
}

/** Ids of chat items that came from a transcript (so a fresh import may replace them). */
export const isImportedItem = (id: string): boolean => /^(t-\d+|import-)/.test(id);
