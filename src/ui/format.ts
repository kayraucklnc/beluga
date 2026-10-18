import type { LogItem } from '../core/store.js';
import { renderMarkdown } from './markdown.js';
import { type Line, type Seg, formatDuration, lineWidth, pad, plain, truncate, wrapText } from './text.js';
import { SPINNER, colorFor, glyph, theme } from './theme.js';

export interface RenderOptions {
  readonly selfId?: string;
  /** Spinner frame counter, advanced by the UI while something is running. */
  readonly frame?: number;
  readonly now?: number;
  /** How much sub-agent work to show: every step, one line each, or just a count. */
  readonly subagents?: 'full' | 'compact' | 'hidden';
  /** Turns paths and URLs in a message into links (how depends on who wrote it, and where). */
  readonly linkify?: (item: LogItem) => ((line: Line) => Line) | undefined;
}

type AgentItem = Extract<LogItem, { type: 'agent' }>;
type ChatItem = Extract<LogItem, { type: 'chat' }>;
type ShellItem = Extract<LogItem, { type: 'shell' }>;

/** Output lines a finished command shows in the chat (its tail). */
const SHELL_TAIL = 14;

/** "/private/var/folders/…/klaud-demo/api" → "…/klaud-demo/api" (short paths stay as they are). */
export const shortFolder = (p: string, max = 32): string => {
  if (p.length <= max) return p;
  const parts = p.split('/').filter(Boolean);
  return `…/${parts.slice(-2).join('/')}`;
};

const GROUP_GAP_MS = 3 * 60_000;
/** Steps a finished run still shows (the last few). */
export const DONE_STEPS = 3;

const time = (ts: number): string => new Date(ts).toTimeString().slice(0, 5);

export const isRunning = (status: AgentItem['status']): boolean =>
  status === 'started' || status === 'text' || status === 'tool' || status === 'sub' || status === 'awaiting_approval' || status === 'queued';

interface StatusStyle {
  readonly label: string;
  readonly color: string;
}

function statusOf(item: AgentItem, opts: RenderOptions): StatusStyle {
  const spin = SPINNER[(opts.frame ?? 0) % SPINNER.length];
  switch (item.status) {
    case 'awaiting_approval':
      return { label: `${glyph.wait} waiting for ${item.ownerName} to approve`, color: theme.warn };
    case 'queued':
      return { label: `${glyph.wait} queued`, color: theme.muted };
    case 'done':
      return { label: `${glyph.ok} done${item.endTs ? ` · ${formatDuration(item.endTs - item.ts)}` : ''}`, color: theme.ok };
    case 'error':
      return { label: `${glyph.fail} failed`, color: theme.error };
    case 'denied':
      return { label: `${glyph.denied} declined`, color: theme.warn };
    default:
      return { label: `${spin} working · ${formatDuration((opts.now ?? Date.now()) - item.ts)}`, color: theme.claude };
  }
}

/** Draw a rounded card around body lines, with a title on the top border. */
export function card(title: Line, right: Line, body: readonly Line[], rawCols: number, border: string): Line[] {
  const cols = Math.max(12, rawCols);
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

/** Tool calls that are plumbing, not progress worth showing to the room. */
export const HIDDEN_STEPS = /^(ToolSearch|TodoWrite)\b/;

function agentLines(item: AgentItem, cols: number, opts: RenderOptions): Line[] {
  const st = statusOf(item, opts);
  const inner = Math.max(10, cols - 2);
  const running = isRunning(item.status);
  const visible = item.steps.filter((s) => !HIDDEN_STEPS.test(s));
  const steps = running ? visible : visible.slice(-DONE_STEPS);
  const hidden = visible.length - steps.length;
  const body: Line[] = [
    ...(hidden > 0 ? [plain(`${glyph.arrow} …${hidden} earlier steps`, { color: theme.muted })] : []),
    ...steps.flatMap((s) => wrapText(`${glyph.arrow} ${s}`, inner).map((t) => plain(t, { color: theme.muted }))),
  ];
  // Sub-agents Claude spun up, nested with their own progress.
  const spin = SPINNER[(opts.frame ?? 0) % SPINNER.length];
  const detail = opts.subagents ?? 'full';
  if (detail === 'hidden' && item.subagents.length) {
    const live = item.subagents.filter((x) => x.status === 'running').length;
    body.push(plain(`◇ ${item.subagents.length} sub-agent${item.subagents.length === 1 ? '' : 's'}${live ? ` · ${live} running` : ''}`, { color: theme.muted }));
  }
  for (const sub of detail === 'hidden' ? [] : item.subagents) {
    const live = sub.status === 'running';
    const background = sub.kind === 'background';
    body.push([
      { text: background ? '▭ ' : '◇ ', color: background ? theme.info : theme.claude },
      { text: live ? `${spin} ` : sub.status === 'failed' ? `${glyph.fail} ` : `${glyph.ok} `, color: live ? theme.claude : sub.status === 'failed' ? theme.error : theme.ok },
      { text: background ? 'background · ' : '', color: theme.info },
      { text: sub.title, color: live ? theme.text : theme.muted, bold: live },
      { text: sub.steps.length ? ` · ${sub.steps.length} step${sub.steps.length === 1 ? '' : 's'}` : '', color: theme.muted },
    ]);
    if (live && detail === 'full') for (const step of sub.steps.slice(-2)) body.push(plain(`    ${glyph.arrow} ${step}`, { color: theme.muted }));
  }
  if (item.text) {
    if (body.length) body.push([]);
    const link = opts.linkify?.(item);
    const text = renderMarkdown(item.text, inner);
    body.push(...(link ? text.map(link) : text));
  }
  if (body.length === 0) {
    const idle =
      item.status === 'awaiting_approval'
        ? `${item.ownerName} needs to approve this before their Claude starts.`
        : item.status === 'queued'
          ? item.owner === opts.selfId
            ? 'Starts when the current task finishes. Run it now or cancel it with the buttons below the box.'
            : 'Starts when the current task finishes.'
          : running
            ? 'thinking…'
            : '';
    body.push(plain(idle, { dim: true }));
  }
  // Someone else's request: "mia (via kay's Claude)", since it ran on kay's computer with kay's Claude.
  const title: Line =
    item.requesterName === item.ownerName
      ? [{ text: `${glyph.claude} ${item.ownerName}'s Claude`, color: theme.claude, bold: true }]
      : [
          { text: `${glyph.claude} ${item.requesterName}`, color: theme.claude, bold: true },
          { text: ` (via ${item.ownerName}'s Claude)`, color: theme.muted },
        ];
  const status = plain(st.label, { color: st.color });
  const gap = Math.max(2, cols - lineWidth(title) - lineWidth(status));
  const rail: Seg = { text: `${glyph.bar} `, color: running ? theme.claude : theme.border };
  return [[...truncate(title, cols - lineWidth(status) - 2), { text: ' '.repeat(gap) }, ...status], ...body.map((l) => [rail, ...truncate(l, inner)])];
}

/** A command run on someone's computer: "$ npm test" with where, who, exit code and the output's tail. */
export function shellLines(item: ShellItem, cols: number, opts: RenderOptions = {}): Line[] {
  const inner = Math.max(10, cols - 2);
  const spin = SPINNER[(opts.frame ?? 0) % SPINNER.length];
  const took = item.endTs ? ` · ${formatDuration(item.endTs - (item.startTs ?? item.ts))}` : '';
  const st: StatusStyle =
    item.status === 'waiting'
      ? { label: `${spin} waiting for ${item.ownerName}`, color: theme.muted }
      : item.status === 'running'
        ? { label: `${spin} running`, color: theme.muted }
        : item.status === 'declined'
        ? { label: `${glyph.denied} declined`, color: theme.warn }
        : item.status === 'failed' || (item.exitCode ?? 0) !== 0
          ? { label: `${glyph.fail} ${item.timedOut ? 'timed out' : item.exitCode !== undefined ? `exit ${item.exitCode}` : 'failed'}${took}`, color: theme.error }
          : { label: `${glyph.ok} exit 0${took}`, color: theme.ok };
  const title: Line = [
    { text: '$ ', color: theme.muted },
    { text: item.command.split('\n')[0] ?? '', color: theme.text, bold: true },
    { text: `  on ${item.ownerName}'s computer${item.cwd ? ` · ${shortFolder(item.cwd)}` : ''} · ${item.by}`, color: theme.muted },
  ];
  const status = plain(st.label, { color: st.color });
  const gap = Math.max(2, cols - lineWidth(title) - lineWidth(status));
  const out = item.output.replace(/\s+$/, '');
  const all = out ? out.split('\n').flatMap((l) => wrapText(l, inner)) : [];
  const shown = all.slice(-SHELL_TAIL);
  const body: Line[] = [
    ...(item.error ? [plain(item.error, { color: item.status === 'declined' ? theme.warn : theme.error })] : []),
    ...(all.length > shown.length || item.truncated ? [plain(`… ${all.length - shown.length} earlier lines`, { color: theme.muted })] : []),
    ...shown.map((t) => plain(t, { color: theme.text })),
    ...(item.status === 'done' && !out && !item.error ? [plain('(no output)', { dim: true })] : []),
  ];
  const rail: Seg = { text: `${glyph.bar} `, color: theme.border };
  return [[...truncate(title, cols - lineWidth(status) - 2), { text: ' '.repeat(gap) }, ...status], ...body.map((l) => [rail, ...truncate(l, inner)])];
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
export function renderLog(items: readonly LogItem[], rawCols: number, opts: RenderOptions = {}): Line[] {
  const cols = Math.max(12, rawCols);
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
    } else if (item.type === 'shell') {
      if (prev) out.push([]);
      out.push(...shellLines(item, cols, opts));
    } else {
      const grouped =
        prev?.type === 'chat' && prev.from === item.from && prev.byAgent === item.byAgent && item.ts - prev.ts < GROUP_GAP_MS;
      if (!grouped) {
        if (prev) out.push([]);
        out.push(chatHeader(item, opts));
      }
      const link = opts.linkify?.(item);
      for (const l of renderMarkdown(item.text, cols - 2)) out.push([{ text: '  ' }, ...(link ? link(l) : l)]);
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
