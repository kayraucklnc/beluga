import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const DRAFT_TIMEOUT_MS = 20_000;
const MAX_TEXT = 8000;
const DRAFT_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
/** New labels a draft may bring (the board's own come first). */
export const NEW_LABELS = 2;
/** A new label: one or two short lowercase words ("mac", "bug", "dark-mode"). */
const LABEL = /^[a-z0-9][a-z0-9-]{0,19}$/;

/** What a task's describer knows besides the words: the project, and the labels the board already uses. */
export interface DraftContext {
  readonly project?: string;
  readonly labels: readonly string[];
}

/** A task written from what someone said they want: a title, its goal, how to tell it's done. */
export interface TaskDraft {
  readonly title: string;
  readonly goal: string;
  readonly acceptance: readonly string[];
  /** The board's own labels that fit, and at most NEW_LABELS new ones when none do. */
  readonly labels: readonly string[];
  /** Only when the words say how much it matters. */
  readonly priority?: (typeof DRAFT_PRIORITIES)[number];
}

const Draft = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(4000),
  acceptance: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  labels: z.array(z.string()).max(12).default([]),
  priority: z.enum(DRAFT_PRIORITIES).nullish(),
});

/** The draft out of what the model said (its JSON object): the board's labels in its own spelling, and a couple of new short ones at most. */
export function parseTaskDraft(raw: string, known: readonly string[]): TaskDraft | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const parsed = Draft.safeParse(json);
  if (!parsed.success) return undefined;
  const { title, goal, acceptance, labels, priority } = parsed.data;
  const byLower = new Map(known.map((l) => [l.toLowerCase(), l]));
  const said = labels.map((l) => l.trim().toLowerCase().replace(/\s+/g, '-'));
  const own = said.flatMap((l) => byLower.get(l) ?? []);
  const fresh = said.filter((l) => !byLower.has(l) && LABEL.test(l)).slice(0, NEW_LABELS);
  const kept = [...new Set([...own, ...fresh])];
  return { title: title.replace(/\s+/g, ' ').replace(/^["“]|["”.]$/g, ''), goal, acceptance, labels: kept, ...(priority ? { priority } : {}) };
}

/** A title without any model: the first line of what was said. */
export function firstLineTitle(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/\s+/g, ' ').trim().slice(0, 120) || 'New task';
}

/** The prompt for the describer (and the mock, which reads it back). */
export function draftPrompt(text: string, ctx: DraftContext): string {
  return [
    ctx.project ? `Project: ${ctx.project}` : '',
    `Labels this board already uses: ${ctx.labels.length ? ctx.labels.join(', ') : '(none)'}`,
    `What they want:\n"""\n${text.slice(0, MAX_TEXT)}\n"""`,
    'Write the task.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const SYSTEM = [
  'You turn what someone wants into a task on their board. Write it in your own words: never paste their message.',
  'Reply with only one JSON object: {"title": string, "goal": string, "acceptance": string[], "labels": string[], "priority": "urgent"|"high"|"medium"|"low"|null}.',
  'title: an imperative, at most 8 words, no period ("Rate-limit the login endpoint").',
  'goal: 1 to 3 sentences of Markdown: what it is for and what done looks like.',
  'acceptance: 1 to 5 short, checkable criteria.',
  'labels: 1 to 3 that clearly fit. Prefer the labels the board already uses; when none fit, make up to 2 new ones,',
  'short and lowercase, about the area or kind of work ("mac", "chat", "bug", "tasks"). Never one for the priority.',
  "priority: only when their words say how much it matters; otherwise null.",
].join('\n');

/**
 * Ask Sonnet to write a task from a description: one turn, no tools, no saved session, on your
 * own Claude login. Undefined on any trouble (the caller keeps the first line as the title).
 */
export async function draftTask(text: string, ctx: DraftContext, opts: { cwd: string; claudePath?: string; model?: string; timeoutMs?: number }): Promise<TaskDraft | undefined> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? DRAFT_TIMEOUT_MS);
  timer.unref();
  try {
    const q = query({
      prompt: draftPrompt(text, ctx),
      options: {
        cwd: opts.cwd,
        model: opts.model ?? 'sonnet',
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController,
        systemPrompt: SYSTEM,
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') return parseTaskDraft(msg.result, ctx.labels);
    }
  } catch {
    // No draft: the first line stays the title.
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}
