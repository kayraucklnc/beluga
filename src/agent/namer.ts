import { query } from '@anthropic-ai/claude-agent-sdk';

const NAME_TIMEOUT_MS = 12_000;
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'please', 'can', 'you', 'we', 'i', 'it', 'is', 'that', 'this', 'my', 'our', 'so', 'be', 'make', 'let', 'lets', "let's"]);
const NAME = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** A readable worktree name from the task text, without any model: the first few meaningful words. */
export function slugify(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  const slug = words.slice(0, 4).join('-').slice(0, 40).replace(/-+$/, '');
  return NAME.test(slug) ? slug : `task-${Date.now().toString(36).slice(-5)}`;
}

/** Keep only a valid name out of whatever the model said. */
export function cleanName(raw: string): string | undefined {
  const line = raw.trim().split('\n')[0] ?? '';
  const slug = line.toLowerCase().replace(/[`"'*.]/g, '').replace(/[\s_/]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return NAME.test(slug) ? slug : undefined;
}

/**
 * Ask a small, fast model (Haiku) to name a worktree after the task. Runs with no tools
 * and no saved session, on your own Claude login. Falls back to `slugify` on any trouble.
 */
export async function nameTask(prompt: string, opts: { cwd: string; claudePath?: string; model?: string }): Promise<string> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), NAME_TIMEOUT_MS);
  timer.unref();
  try {
    const q = query({
      prompt: `Task:\n"""\n${prompt.slice(0, 2000)}\n"""\nName a git worktree for this task.`,
      options: {
        cwd: opts.cwd,
        model: opts.model ?? 'haiku',
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController,
        systemPrompt: 'You name git worktrees. Reply with only the name: 2 to 4 lowercase English words joined by hyphens (e.g. "fix-login-redirect"). No other text.',
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') return cleanName(msg.result) ?? slugify(prompt);
    }
  } catch {
    // fall through to the local name
  } finally {
    clearTimeout(timer);
  }
  return slugify(prompt);
}

const PLAN_TITLE_WORDS = 6;

/** A plan's name out of whatever the model said: one line, no quotes or end mark, at most six words. */
export function cleanPlanTitle(raw: string): string | undefined {
  const line = (raw.trim().split('\n')[0] ?? '').replace(/^(title|name)\s*:\s*/i, '').replace(/[`"“”*#]/g, '').replace(/[.!?:;,]+$/, '').replace(/\s+/g, ' ').trim();
  const words = line.split(' ').filter(Boolean);
  if (!words.length || words.length > PLAN_TITLE_WORDS * 2) return undefined;
  const title = words.slice(0, PLAN_TITLE_WORDS).join(' ').slice(0, 60).trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : undefined;
}

/**
 * A short name for a new plan from what you asked for (Haiku, one turn, no tools), so the plan's
 * page and the sidebar never show your message cut off. Undefined on any trouble: it stays "New plan".
 */
export async function titlePlan(goal: string, opts: { cwd: string; claudePath?: string; model?: string }): Promise<string | undefined> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), NAME_TIMEOUT_MS);
  timer.unref();
  try {
    const q = query({
      prompt: `What the plan is for:\n"""\n${goal.slice(0, 3000)}\n"""\nName this plan.`,
      options: {
        cwd: opts.cwd,
        model: opts.model ?? 'haiku',
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController,
        systemPrompt: `You name project plans. Reply with only the name: 2 to ${PLAN_TITLE_WORDS} plain words in sentence case that say what the plan achieves (e.g. "Card checkout for launch", "Calmer plan drafting screen"). No quotes, no end punctuation, no other text.`,
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') return cleanPlanTitle(msg.result);
    }
  } catch {
    // stays "New plan" until Claude writes the plan
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}
