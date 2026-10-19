import type { AgentRunInput } from './types.js';

// The demo's Claude filling its context window as it works, and compacting it, so the context
// meter, auto-compact and the compaction divider all have something real to show.

const WINDOW = 200_000;
/** Each tool call reads something in; each answer adds a little more. */
const PER_STEP = 1_500;
const PER_ANSWER = 3_000;
const START = 24_000;
const MAX = 196_000;
/** Claude Code's system prompt, tools and CLAUDE.md: what's always there. */
const SYSTEM = 15_000;

/** Seeded fill levels (by conversation folder) for the demo's conversations, before anything runs. */
const seeded = new Map<string, number>();

/** Start a demo conversation (its folder) this full. */
export function seedMockContext(cwd: string, used: number): void {
  seeded.set(cwd, Math.max(0, Math.min(MAX, Math.round(used))));
}

/** What the demo's Claude remembers after compacting: the shape of a real summary. */
export function mockSummary(instructions: string): string {
  const focus = instructions.trim() && !/^Keep every decision/.test(instructions.trim()) ? `\n\n**Kept in focus:** ${instructions.trim()}` : '';
  return [
    '## Where we are',
    '**Goal:** protect the payments API with session auth, then deploy.',
    '',
    '**Decisions**',
    '- Sessions use signed cookies (no server state): `httpOnly`, `sameSite=lax`.',
    '- `requireUser()` guards every route under `/api/payments/*`.',
    '',
    '**Done**',
    '- `src/auth.ts` adds `requireUser()`; `src/server.ts` uses it.',
    '- All 27 tests pass (`npm test`).',
    '',
    '**Open tasks**',
    '- Add a test for expired sessions.',
    '- Webhook retries in `src/webhooks.ts` are not idempotent yet.',
    '',
    '**Files touched:** `src/auth.ts`, `src/server.ts`, `src/webhooks.ts`',
  ].join('\n') + focus;
}

/** The demo's context, per conversation (its folder; the room's Claude has its own). */
export class MockContext {
  private readonly used = new Map<string, number>();

  private keyOf(input: AgentRunInput): string {
    return input.place?.cwd ?? 'room';
  }

  private current(key: string): number {
    return this.used.get(key) ?? seeded.get(key) ?? START;
  }

  private report(input: AgentRunInput, used: number): void {
    const tools = Math.round((used - SYSTEM) * 0.55);
    input.onEvent('context', JSON.stringify({ used, window: WINDOW, breakdown: { conversation: Math.max(0, used - SYSTEM - tools), tools: Math.max(0, tools), system: Math.min(SYSTEM, used) } }));
  }

  /** Claude read or ran something: the window fills a little (the meter moves while it works). */
  grow(input: AgentRunInput, tokens = PER_STEP): number {
    const key = this.keyOf(input);
    const used = Math.min(MAX, this.current(key) + tokens);
    this.used.set(key, used);
    this.report(input, used);
    return used;
  }

  /** The run answered. */
  finish(input: AgentRunInput): number {
    return this.grow(input, PER_ANSWER);
  }

  /** /compact: summarize, then continue from the summary (about a tenth of what was there). */
  async compact(input: AgentRunInput, wait: (ms: number) => Promise<void>): Promise<string> {
    const key = this.keyOf(input);
    const pre = this.current(key);
    await wait(900);
    const post = Math.max(SYSTEM + 4_000, Math.round(pre * 0.13));
    this.used.set(key, post);
    const instructions = input.prompt.trim().replace(/^\/compact\s*/, '');
    input.onEvent('compact', JSON.stringify({ pre, post, trigger: 'manual', window: WINDOW, summary: mockSummary(instructions) }));
    return 'Compacted the conversation. I kept the plan, decisions so far, and open TODOs.';
  }
}

/** The run's events, with the window filling a little on every tool call. */
export function withGrowingContext(input: AgentRunInput, context: MockContext): AgentRunInput {
  return {
    ...input,
    onEvent: (kind, text) => {
      input.onEvent(kind, text);
      if (kind === 'tool') context.grow(input);
    },
  };
}
