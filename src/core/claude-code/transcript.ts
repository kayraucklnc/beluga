import type { CcStep } from './model.js';
import { boundInput, boundText, redactSecrets, resultText, thinkingOf } from '../../shared/steps.js';
import { type OutputRef, pathsInText, refsOfTool } from './outputs.js';
import { type BgLaunch, bgLaunchOf, outputFileOf, taskIdOf } from './tasks.js';

/**
 * Claude Code's transcript lines → what Beluga shows: readable steps ("Reading src/app.ts", Claude's
 * words, your messages), the session's title and folder, sub-agents it started and how they
 * ended. Pure: no files (tail.ts reads them, sessions.ts keeps the state), so anything showing
 * Claude Code's conversations can reuse it. Unknown entry types are ignored.
 */

/** A transcript line, only the parts we read. */
export interface RawEntry {
  readonly type?: string;
  readonly subtype?: string;
  readonly timestamp?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly isMeta?: boolean;
  readonly agentId?: string;
  /** How hard Claude thinks on this turn ("low" … "max"), as Claude Code records it. */
  readonly effort?: string;
  readonly message?: { readonly role?: string; readonly content?: unknown; readonly model?: string; readonly usage?: Usage; readonly stop_reason?: string | null };
  readonly toolUseResult?: unknown;
  readonly summary?: string;
  readonly aiTitle?: string;
  readonly operation?: string;
  readonly content?: unknown;
  readonly attachment?: { readonly type?: string; readonly prompt?: unknown };
  /** Where a message came from: the lead session ('coordinator') or another agent ('peer'). */
  readonly origin?: { readonly kind?: string; readonly from?: string; readonly name?: string };
}

interface Usage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

/** What opening a step shows (kept beside it, bounded and with secrets redacted). */
export interface StepDetail {
  readonly input?: Readonly<Record<string, unknown>>;
  readonly output?: string;
  readonly text?: string;
  readonly truncated?: boolean;
}

/** A step before it has its place in the transcript (sessions.ts numbers them). */
export type StepDraft = Omit<CcStep, 'seq'> & { readonly toolUseId?: string; readonly details?: StepDetail };

/** A sub-agent (Agent or Task tool) the session started. */
export interface Launch {
  readonly toolUseId: string;
  readonly description: string;
  readonly type: string;
  readonly background: boolean;
  readonly ts: number;
  /** The name it was given (others message it by this). */
  readonly name?: string;
}

/** A message this transcript's Claude sent another session (SendMessage). */
export interface Sent {
  /** An agent's id or name, or 'main' for the lead session. */
  readonly to: string;
  readonly summary: string;
  readonly ts: number;
}

/** A tool's result: for a sub-agent, whether it went to the background or ended. */
export interface ToolResult {
  readonly toolUseId: string;
  readonly error: boolean;
  /** "Async agent launched…": the agent goes on in the background. */
  readonly async: boolean;
  readonly agentId?: string;
  readonly ts: number;
  /** What came back (bounded, secrets redacted). */
  readonly output?: string;
  readonly truncated?: boolean;
  /** A background command or watch it started: Claude Code's id for it, and where its output goes. */
  readonly taskId?: string;
  readonly outputFile?: string;
}

/** A background task reporting back (`<task-notification>`): an agent or a command finished. */
export interface TaskNotice {
  readonly taskId: string;
  readonly toolUseId?: string;
  /** completed, failed, killed… as Claude Code says it. */
  readonly status: string;
  readonly summary?: string;
  readonly ts: number;
}

/** Everything one entry tells. */
export interface Facts {
  readonly ts?: number;
  readonly cwd?: string;
  readonly title?: string;
  /** Claude Code's own title (beats the first message). */
  readonly aiTitle?: string;
  readonly steps: readonly StepDraft[];
  readonly results: readonly ToolResult[];
  readonly launches: readonly Launch[];
  readonly notices: readonly TaskNotice[];
  /** Messages sent to other sessions (SendMessage). */
  readonly sends?: readonly Sent[];
  /** Background commands and watches it started (see tasks.ts). */
  readonly bg?: readonly BgLaunch[];
  /** Files it made or looked at (screenshots, logs…): see outputs.ts. */
  readonly outputs?: readonly OutputRef[];
  /** Context size at this answer (tokens). */
  readonly tokens?: number;
  readonly model?: string;
  readonly effort?: string;
  /** true: Claude ended its turn here; false: the conversation went on; undefined: says nothing. */
  readonly final?: boolean;
}

/** Lines longer than this are pictures or dumps, not worth parsing. */
export const MAX_LINE = 8 * 1024 * 1024;
const TEXT_MAX = 8000;
const USER_MAX = 4000;
const ARG_MAX = 90;
/** Claude Code's request logs: big, and nothing to show. */
const SKIP_PREFIX = /^\{"type":"(api-request|api-request-blob|api-request-shape)"/;
/** Lines Claude Code adds itself (slash commands, hooks, reminders): not something you typed. */
const MACHINE = /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook|bash-|local-command-stdout)/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
/** Instructions a tool wraps around what you typed (Conductor adds <system_instruction>). */
const WRAPPERS = /<(system_instruction|system-instruction)>[\s\S]*?<\/\1>/g;
const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
/** A message from the lead session to an agent. */
const FROM_LEAD = /^The coordinator sent a message(?: while you were working)?:[ \t]*\n?/;
/** A message from another session (an agent, or an agent's final report handed back). */
const AGENT_MESSAGE = /<agent-message from="([^"]{1,200})">\n?([\s\S]*?)(?:<\/agent-message>|$)/;
const HANDBACK = /^\s*\[Subagent hand-back\]/;
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** One line → its entry (undefined: blank, broken, too big, or a request log). */
export function parseLine(line: string): RawEntry | undefined {
  if (!line || line.length > MAX_LINE || SKIP_PREFIX.test(line)) return undefined;
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RawEntry) : undefined;
  } catch {
    return undefined;
  }
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A path shown relative to the folder Claude works in. */
function rel(p: string, cwd?: string): string {
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return p;
}

/** A tool call in words: "Reading src/core/store.ts", "Running npm test", "Agent: Fix the sidebar". */
export function describeTool(name: string, input: Record<string, unknown>, cwd?: string): string {
  const file = rel(str(input.file_path) || str(input.notebook_path) || str(input.path), cwd);
  const arg = (s: string): string => clip(oneLine(s), ARG_MAX);
  // A long path keeps its end: the file's name (and what kind it is) is what you look for.
  const tail = (s: string): string => (oneLine(s).length > ARG_MAX ? `…${oneLine(s).slice(-(ARG_MAX - 1))}` : oneLine(s));
  switch (name) {
    case 'Read':
      return file ? `Reading ${tail(file)}` : 'Reading';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `Editing ${arg(file)}` : 'Editing';
    case 'Write':
      return file ? `Writing ${arg(file)}` : 'Writing';
    case 'Bash': {
      const desc = str(input.description);
      const cmd = str(input.command);
      return desc ? arg(desc) : cmd ? `Running ${arg(cmd)}` : 'Running a command';
    }
    case 'BashOutput':
      return 'Checking a background command';
    case 'KillShell':
    case 'KillBash':
      return 'Stopping a background command';
    case 'Grep':
      return input.pattern ? `Searching for ${arg(str(input.pattern))}${file ? ` in ${arg(file)}` : ''}` : 'Searching';
    case 'Glob':
      return input.pattern ? `Finding ${arg(str(input.pattern))}` : 'Finding files';
    case 'LS':
      return file ? `Listing ${arg(file)}` : 'Listing files';
    case 'WebFetch':
      return input.url ? `Fetching ${arg(str(input.url))}` : 'Fetching a page';
    case 'WebSearch':
      return input.query ? `Searching the web for ${arg(str(input.query))}` : 'Searching the web';
    case 'TodoWrite':
      return 'Updating the plan';
    case 'Agent':
    case 'Task':
      return `Agent: ${arg(str(input.description) || str(input.subagent_type) || 'a sub-agent')}`;
    case 'SendMessage': {
      const to = str(input.to) || str(input.recipient);
      const about = str(input.summary) || str(input.message) || str(input.content);
      return `→ sent to ${to || 'an agent'}${about ? `: ${arg(about)}` : ''}`;
    }
    case 'Skill':
      return input.skill ? `Using ${arg(str(input.skill))}` : 'Using a skill';
    default: {
      const short = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
      const any = file || str(input.command) || str(input.query) || str(input.pattern) || str(input.url) || str(input.title);
      return any ? `${short} ${arg(any)}` : short;
    }
  }
}

type Block = { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown; thinking?: unknown };

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]).filter((b) => b && typeof b === 'object') : [];
}

const tsOf = (e: RawEntry): number | undefined => {
  const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** Every `<task-notification>` in a text. */
export function parseNotices(text: string, ts: number): TaskNotice[] {
  const out: TaskNotice[] = [];
  for (const m of text.matchAll(NOTICE)) {
    const body = m[1] ?? '';
    const tag = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim();
    const taskId = tag('task-id');
    const status = tag('status');
    if (!taskId || !status) continue;
    const toolUseId = tag('tool-use-id');
    const summary = tag('summary');
    out.push({ taskId, status, ts, ...(toolUseId ? { toolUseId } : {}), ...(summary ? { summary } : {}) });
  }
  return out;
}

/** What you typed, without the instructions tools wrap around it. */
function typed(blocks: readonly Block[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .replace(WRAPPERS, '')
    .trim();
}

const noticeStep = (n: TaskNotice): StepDraft => ({ ts: n.ts, kind: 'note', text: n.summary ?? `A background task ${n.status === 'completed' ? 'finished' : n.status}` });

/** A report handed back: its words, without the harness's preamble and indent. */
function reportText(body: string): string {
  const rest = body.replace(/^\s*\[Subagent hand-back\][^\n]*(?:\n(?!\s*\n)[^\n]*)*\n\s*\n/, '');
  const lines = rest.split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return (Number.isFinite(indent) && indent > 0 ? lines.map((l) => l.slice(indent)) : lines).join('\n').trim();
}

/** A message another session sent this one (SendMessage), as a step; undefined when it isn't one. */
export function messageStep(text: string, ts: number, origin?: RawEntry['origin']): StepDraft | undefined {
  const m = AGENT_MESSAGE.exec(text);
  if (m) {
    const body = m[2] ?? '';
    const report = HANDBACK.test(body);
    const words = report ? reportText(body) : body.trim();
    return { ts, kind: 'message', from: origin?.from ?? m[1]!, text: clip(words || '(empty message)', TEXT_MAX), ...(report ? { report: true } : {}) };
  }
  if (origin?.kind === 'coordinator' || FROM_LEAD.test(text)) {
    const words = text.replace(FROM_LEAD, '').trim();
    return words ? { ts, kind: 'message', from: 'lead', text: clip(words, TEXT_MAX) } : undefined;
  }
  return undefined;
}

function userFacts(e: RawEntry, ts: number): Facts {
  const blocks = blocksOf(e.message?.content);
  const results: ToolResult[] = [];
  const outputs: OutputRef[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_result' || !b.tool_use_id) continue;
    const tur = (e.toolUseResult ?? {}) as { status?: unknown; isAsync?: unknown; agentId?: unknown };
    const firstText = blocksOf(b.content).find((x) => x.type === 'text')?.text ?? '';
    const async = tur.status === 'async_launched' || tur.isAsync === true || /^Async agent launched/.test(firstText);
    const full = resultText(b.content);
    for (const p of pathsInText(full)) outputs.push({ path: p, how: 'ran', ts });
    const out = boundText(redactSecrets(full));
    const taskId = taskIdOf(e.toolUseResult, firstText);
    const outputFile = taskId ? outputFileOf(firstText) : undefined;
    results.push({ toolUseId: b.tool_use_id, error: b.is_error === true, async, ts, output: out.text, ...(out.truncated ? { truncated: true } : {}), ...(typeof tur.agentId === 'string' ? { agentId: tur.agentId } : {}), ...(taskId ? { taskId } : {}), ...(outputFile ? { outputFile } : {}) });
  }
  if (results.length) return { ts, steps: [], results, launches: [], notices: [], final: false, ...(outputs.length ? { outputs } : {}) };
  const text = typed(blocks);
  const notices = parseNotices(text, ts);
  if (notices.length) return { ts, steps: notices.map(noticeStep), results: [], launches: [], notices, final: false };
  // Another session messaged this one: it wakes up and works on it.
  const message = messageStep(text, ts, e.origin);
  if (message) return { ts, steps: [message], results: [], launches: [], notices: [], final: false };
  if (!text || e.isMeta || MACHINE.test(text)) return { ts, steps: [], results: [], launches: [], notices: [] };
  if (INTERRUPTED.test(text)) return { ts, steps: [{ ts, kind: 'note', text: 'Interrupted' }], results: [], launches: [], notices: [], final: false };
  return { ts, title: clip(oneLine(text), 120), steps: [{ ts, kind: 'user', text: clip(text, USER_MAX) }], results: [], launches: [], notices: [], final: false };
}

function assistantFacts(e: RawEntry, ts: number, cwd: string | undefined): Facts {
  const m = e.message ?? {};
  const synthetic = m.model === '<synthetic>';
  const steps: StepDraft[] = [];
  const launches: Launch[] = [];
  const sends: Sent[] = [];
  const outputs: OutputRef[] = [];
  const bg: BgLaunch[] = [];
  for (const b of blocksOf(m.content)) {
    if (b.type === 'text' && b.text?.trim()) steps.push({ ts, kind: synthetic ? 'note' : 'text', text: clip(b.text.trim(), TEXT_MAX) });
    if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const t = b.type === 'thinking' ? thinkingOf(b) : { text: '', hidden: true, truncated: false };
      steps.push({ ts, kind: 'thinking', text: t.hidden ? 'Thinking (hidden by Claude)' : 'Thought', ...(t.hidden ? { hidden: true } : { detail: true, details: { text: t.text, ...(t.truncated ? { truncated: true } : {}) } }) });
      continue;
    }
    if (b.type !== 'tool_use' || !b.name) continue;
    const input = b.input ?? {};
    outputs.push(...refsOfTool(b.name, input, cwd, ts));
    const task = b.id ? bgLaunchOf(b.id, b.name, input, ts) : undefined;
    if (task) bg.push(task);
    const kept = boundInput(input);
    const to = b.name === 'SendMessage' ? str(input.to) || str(input.recipient) : '';
    steps.push({ ts, kind: 'tool', tool: b.name, text: redactSecrets(describeTool(b.name, input, cwd)), status: 'running', detail: true, details: { input: kept.input, ...(kept.truncated ? { truncated: true } : {}) }, ...(b.id ? { toolUseId: b.id } : {}), ...(to ? { to } : {}) });
    if (to) sends.push({ to, summary: clip(oneLine(redactSecrets(str(input.summary) || str(input.message) || str(input.content))), ARG_MAX), ts });
    if (AGENT_TOOLS.has(b.name) && b.id) {
      const name = oneLine(str(input.name));
      launches.push({ toolUseId: b.id, description: oneLine(str(input.description)) || 'Sub-agent', type: str(input.subagent_type) || 'general-purpose', background: input.run_in_background === true, ts, ...(name ? { name } : {}) });
    }
  }
  const u = m.usage;
  const tokens = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) : undefined;
  const ended = m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence';
  return {
    ts,
    steps,
    results: [],
    launches,
    notices: [],
    ...(sends.length ? { sends } : {}),
    ...(outputs.length ? { outputs } : {}),
    ...(bg.length ? { bg } : {}),
    ...(tokens && !synthetic ? { tokens } : {}),
    ...(m.model && !synthetic ? { model: m.model } : {}),
    ...(typeof e.effort === 'string' && /^[\w-]{1,20}$/.test(e.effort) ? { effort: e.effort } : {}),
    final: ended && !launches.length && !steps.some((s) => s.kind === 'tool'),
  };
}

/** What one transcript entry tells (cwd: the folder paths are shown relative to). */
export function factsOf(e: RawEntry, cwd?: string): Facts {
  const ts = tsOf(e);
  const base = { ...(ts !== undefined ? { ts } : {}), ...(e.cwd ? { cwd: e.cwd } : {}) };
  const none: Facts = { ...base, steps: [], results: [], launches: [], notices: [] };
  const at = ts ?? 0;
  switch (e.type) {
    case 'user':
      return { ...userFacts(e, at), ...base };
    case 'assistant':
      return { ...assistantFacts(e, at, e.cwd ?? cwd), ...base };
    case 'summary':
      return typeof e.summary === 'string' && e.summary.trim() ? { ...none, title: clip(oneLine(e.summary), 120) } : none;
    case 'ai-title':
      return typeof e.aiTitle === 'string' && e.aiTitle.trim() ? { ...none, aiTitle: clip(oneLine(e.aiTitle), 120) } : none;
    case 'queue-operation':
      // Only when it's queued: the same notice comes again as it's taken off the queue.
      return e.operation === 'enqueue' && typeof e.content === 'string' ? { ...none, notices: parseNotices(e.content, at) } : none;
    case 'attachment': {
      const prompt = e.attachment?.type === 'queued_command' ? str(e.attachment.prompt) : '';
      const notices = prompt ? parseNotices(prompt, at) : [];
      if (notices.length) return { ...none, notices, steps: notices.map(noticeStep) };
      // A message from another session, delivered while this one was working.
      const message = prompt ? messageStep(prompt, at, e.origin) : undefined;
      return message ? { ...none, steps: [message], final: false } : none;
    }
    case 'system':
      return e.subtype === 'compact_boundary' ? { ...none, steps: [{ ts: at, kind: 'note', text: 'Conversation compacted' }] } : none;
    default:
      return none;
  }
}
