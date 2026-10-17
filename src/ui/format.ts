import type { LogItem } from '../core/store.js';
import { renderMarkdown } from './markdown.js';
import { type Line, type Seg, formatDuration, lineWidth, pad, plain, truncate, wrapText } from './text.js';
import { SPINNER, colorFor, glyph, theme } from './theme.js';

export interface RenderOptions {
  readonly selfId?: string;
  /** Spinner frame counter, advanced by the UI while something is running. */
  readonly frame?: number;
  readonly now?: number;
}

type AgentItem = Extract<LogItem, { type: 'agent' }>;
type ChatItem = Extract<LogItem, { type: 'chat' }>;

const GROUP_GAP_MS = 3 * 60_000;
const DONE_STEPS = 3;

const time = (ts: number): string => new Date(ts).toTimeString().slice(0, 5);

export const isRunning = (status: AgentItem['status']): boolean =>
  status === 'started' || status === 'text' || status === 'tool' || status === 'awaiting_approval';

interface StatusStyle {
  readonly label: string;
  readonly color: string;
}

function statusOf(item: AgentItem, opts: RenderOptions): StatusStyle {
  const spin = SPINNER[(opts.frame ?? 0) % SPINNER.length];
  switch (item.status) {
    case 'awaiting_approval':
      return { label: `${glyph.wait} waiting for ${item.ownerName} to approve`, color: theme.warn };
    case 'done':
      return { label: `${glyph.ok} done`, color: theme.ok };
    case 'error':
      return { label: `${glyph.fail} failed`, color: theme.error };
    case 'denied':
      return { label: `${glyph.denied} declined`, color: theme.warn };
    default:
      return { label: `${spin} working · ${formatDuration((opts.now ?? Date.now()) - item.ts)}`, color: theme.claude };
  }
}

/** Draw a rounded card around body lines, with a title on the top border. */
export function card(title: Line, right: Line, body: readonly Line[], cols: number, border: string): Line[] {
  const inner = Math.max(10, cols - 4);
  const rightWidth = lineWidth(right);
  const titleLine = truncate(title, Math.max(4, cols - rightWidth - 10));
  const b = (text: string): Seg => ({ text, color: border });
  const top: Line = rightWidth
    ? [b('╭─ '), ...titleLine, b(` ${'─'.repeat(Math.max(1, cols - 8 - lineWidth(titleLine) - rightWidth))} `), ...right, b(' ─╮')]
    : [b('╭─ '), ...titleLine, b(` ${'─'.repeat(Math.max(1, cols - 5 - lineWidth(titleLine)))}╮`)];
  return [
    top,
    ...body.map((l) => [b('│ '), ...pad(l, inner), b(' │')]),
    [b(`╰${'─'.repeat(cols - 2)}╯`)],
  ];
}

function agentLines(item: AgentItem, cols: number, opts: RenderOptions): Line[] {
  const st = statusOf(item, opts);
  const inner = Math.max(10, cols - 4);
  const running = isRunning(item.status);
  const steps = running ? item.steps : item.steps.slice(-DONE_STEPS);
  const hidden = item.steps.length - steps.length;
  const body: Line[] = [
    ...(hidden > 0 ? [plain(`${glyph.arrow} …${hidden} earlier steps`, { color: theme.muted })] : []),
    ...steps.flatMap((s) => wrapText(`${glyph.arrow} ${s}`, inner).map((t) => plain(t, { color: theme.muted }))),
  ];
  if (item.text) {
    if (body.length) body.push([]);
    body.push(...renderMarkdown(item.text, inner));
  }
  if (body.length === 0) {
    const idle = item.status === 'awaiting_approval' ? `${item.ownerName} needs to approve this before their Claude starts.` : running ? 'thinking…' : '';
    body.push(plain(idle, { dim: true }));
  }
  const title: Line = [
    { text: `${glyph.claude} ${item.ownerName}'s Claude`, color: theme.claude, bold: true },
    { text: item.requesterName === item.ownerName ? '' : `  asked by ${item.requesterName}`, color: theme.muted },
  ];
  return card(title, plain(st.label, { color: st.color }), body, cols, running ? st.color : theme.border);
}

function chatHeader(item: ChatItem, opts: RenderOptions): Line {
  const self = item.from === opts.selfId && !item.byAgent;
  const name = item.byAgent ? `${glyph.claude} ${item.name}` : self ? 'you' : item.name;
  const color = item.byAgent ? theme.claude : colorFor(item.name);
  return [
    { text: name, color, bold: true },
    { text: `  ${time(item.ts)}`, color: theme.muted },
  ];
}

/** Flatten the room log into terminal lines: grouped chat, system notes, and agent cards. */
export function renderLog(items: readonly LogItem[], cols: number, opts: RenderOptions = {}): Line[] {
  const out: Line[] = [];
  let prev: LogItem | undefined;
  for (const item of items) {
    if (item.type === 'system') {
      const color = item.level === 'error' ? theme.error : item.level === 'warn' ? theme.warn : theme.muted;
      if (prev && prev.type !== 'system') out.push([]);
      for (const t of wrapText(item.text, cols - 2)) out.push(plain(`  ${t}`, { color, dim: item.level === 'info' }));
    } else if (item.type === 'agent') {
      if (prev) out.push([]);
      out.push(...agentLines(item, cols, opts));
    } else {
      const grouped =
        prev?.type === 'chat' && prev.from === item.from && prev.byAgent === item.byAgent && item.ts - prev.ts < GROUP_GAP_MS;
      if (!grouped) {
        if (prev) out.push([]);
        out.push(chatHeader(item, opts));
      }
      for (const l of renderMarkdown(item.text, cols - 2)) out.push([{ text: '  ' }, ...l]);
    }
    prev = item;
  }
  return out;
}

const APPROVAL_LINES = 6;

/** Wrap an approval's detail (e.g. a shell command) so the owner sees as much of it as possible. */
export function approvalLines(detail: string, cols: number): string[] {
  const lines = wrapText(detail, cols);
  if (lines.length <= APPROVAL_LINES) return lines;
  return [...lines.slice(0, APPROVAL_LINES - 1), `… ${lines.length - APPROVAL_LINES + 1} more lines (${detail.length} chars)`];
}
