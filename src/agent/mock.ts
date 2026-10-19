import type { AgentBackend, AgentRunInput, RoomBridge } from './types.js';
import { slugify } from './namer.js';
import { MORE, MockStepper, splitLine } from './mock-steps.js';
import { MockContext, withGrowingContext } from './mock-context.js';

interface Script {
  readonly match: RegExp;
  readonly steps: readonly string[];
  readonly answer: string;
  /** How long each step takes (at pace 1); the default is quick. */
  readonly stepMs?: number;
  readonly report?: { title: string; markdown: string };
  /** Sub-agents launched in parallel, each with its own steps. */
  readonly subagents?: ReadonlyArray<{ title: string; steps: readonly string[]; kind?: 'agent' | 'background' }>;
}

/** Canned, fast replies so the demo (and README recordings) never wait on real Claude calls. */
const SCRIPTS: readonly Script[] = [
  {
    // A long task, so you can try queueing messages (and sending one now) while Claude works.
    match: /deep dive|take your time/i,
    stepMs: 2500,
    steps: ['Glob **/*.ts', 'Read src/server.ts', 'Read src/payments.ts', 'Grep "TODO"', 'Read NOTES.md', 'Grep "session"', 'Read src/webhooks.ts', 'Bash npm test', 'Read package.json', 'Grep "retry"', 'Read README.md', 'Bash git log --oneline -20'],
    answer: 'Deep dive done. The riskiest parts are **webhook retries** (not idempotent) and **auth** (not started). Everything else is small and well tested.',
  },
  {
    match: /review|changes|check my work/i,
    steps: ['Bash git diff origin/main --stat'],
    subagents: [
      { title: 'code-reviewer · correctness', steps: ['Read src/auth.ts', 'Read src/server.ts', 'Grep "session"', 'Read src/payments.ts'] },
      { title: 'security-reviewer · auth flow', steps: ['Read src/auth.ts', 'Grep "cookie"', 'Grep "secret"'] },
      { title: 'test-runner · run tests', steps: ['Bash npm test', 'Bash npm test -- --coverage'] },
    ],
    answer:
      '**Looks good to merge.** 3 reviewers checked it.\n\n- `requireUser()` correctly rejects missing sessions\n- Cookie is `httpOnly` and `sameSite=lax`\n- All **27 tests** pass\n\n**One suggestion:** add a test for expired sessions.',
  },
  {
    match: /build|implement|add|create|make/i,
    steps: ['Read src/server.ts', 'Write src/auth.ts', 'Edit src/server.ts', 'Bash npm test'],
    subagents: [
      { title: 'Explore · find the right place', steps: ['Glob src/**/*.ts', 'Grep "app.get"', 'Read src/server.ts'] },
      { title: 'Plan · design the change', steps: ['Read README.md', 'Read content/hero.md'] },
    ],
    answer: 'Done. Added `src/auth.ts` with a `requireUser()` middleware and wired it into `/api/payments/*`. Run `npm test` to see the new tests.',
  },
  {
    match: /auth|login|security/i,
    steps: ['Read NOTES.md', 'Grep "auth" src/', 'Read src/server.ts'],
    answer:
      "Auth isn't wired up yet. `src/server.ts` has a `TODO: add auth` and no middleware.\n\n**Plan:**\n- Add a session check in `requireUser()`\n- Protect `/api/payments/*`\n- Cover it with 3 tests",
  },
  {
    match: /report|write up|summary|summarize/i,
    steps: ['Glob **/*.md', 'Read README.md', 'write_report Project overview'],
    answer: 'Wrote **Project overview** to `.klaud/reports/`. Open it from the files panel.',
    report: {
      title: 'Project overview',
      markdown: '# Project overview\n\n- **Stack:** Node + TypeScript\n- **Status:** payments in progress, auth not started\n- **Next:** add auth middleware, then deploy\n',
    },
  },
  {
    match: /test/i,
    steps: ['Read package.json', 'Bash npm test'],
    subagents: [{ title: 'npm test --watch', steps: ['24 passed', '24 passed'], kind: 'background' }],
    answer: 'All **24 tests** pass. Coverage is 87%; `payments.ts` is the least covered file.',
  },
];

/** A request to change something (the main folder can't, so it moves to a worktree). */
const WANTS_CHANGE = /\b(build|implement|add|create|make|fix|change|edit|refactor|rename|update|remove|delete|write(?! up)|commit)\b/i;

const FALLBACK: Script = {
  match: /.*/,
  steps: ['Read README.md', 'Glob src/**'],
  answer: 'This is a small TypeScript API. `README.md` covers setup and `NOTES.md` tracks open work. Ask me about auth, tests, or a written report.',
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

const MOCK_PLAN = `## Plan: add auth

1. Add \`src/auth.ts\` with a \`requireUser()\` middleware
2. Protect \`/api/payments/*\`
3. Cover it with 3 tests (missing, expired, valid session)

Nothing is changed until you approve.`;

async function mockPlan(input: AgentRunInput, pace: number): Promise<string> {
  for (const step of ['Read src/server.ts', 'Grep "app.get"', 'Read NOTES.md']) {
    await sleep(450 * pace, input.signal);
    input.onEvent('tool', step);
  }
  input.onEvent('text', MOCK_PLAN);
  const answer = input.askUser ? await input.askUser({ kind: 'plan', plan: MOCK_PLAN }) : ({ kind: 'skip' } as const);
  if (answer.kind !== 'plan' || !answer.approve) return answer.kind === 'plan' && answer.feedback ? `Got it. I'll revise the plan: ${answer.feedback}` : 'Okay, I left everything as it was.';
  for (const step of ['Write src/auth.ts', 'Edit src/server.ts', 'Bash npm test']) {
    await sleep(450 * pace, input.signal);
    input.onEvent('tool', step);
  }
  return 'Done. `requireUser()` protects `/api/payments/*` and all **27 tests** pass.';
}

/** "run the tests on bob's computer" / "check my machine": whose computer, and which command. */
export function peerRunTarget(prompt: string, requester: string): { peer: string; command: string } | undefined {
  const named = /\bon (\w[\w.-]*)'s (computer|machine|laptop)\b/i.exec(prompt);
  const mine = /\b(on|check) my (computer|machine|laptop)\b/i.test(prompt);
  if (!named && !mine) return undefined;
  const quoted = /`([^`]+)`/.exec(prompt)?.[1];
  const command = quoted ?? (/\btests?\b/i.test(prompt) ? 'npm test' : 'ls');
  return { peer: named ? named[1]! : requester, command };
}

async function mockPeerRun(input: AgentRunInput, bridge: RoomBridge, target: { peer: string; command: string }, pace: number): Promise<string> {
  await sleep(450 * pace, input.signal);
  input.onEvent('tool', 'list_peers');
  input.onEvent('tool', `run_on_peer ${target.command}${MORE}${JSON.stringify({ peer: target.peer })}`);
  const result = await bridge.runOnPeer!(target.peer, target.command, { why: 'to check before I change anything' }).catch((err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  const head = result.split('\n')[0] ?? '';
  if (/did not run|failed:/.test(head)) return `I couldn't run \`${target.command}\` on ${target.peer}'s computer: ${head.replace(/^.*?: /, '')}`;
  const passed = /(\d+) passed \(/.exec(result.split('\n').filter((l) => /Tests/.test(l)).join('\n'))?.[1];
  return `Ran \`${target.command}\` on ${target.peer}'s computer. ${head}.${passed ? ` **${passed} tests pass.**` : ''}`;
}

/** "ask bob to run the tests" / "ask mia's Claude whether …" / "@bob run the tests": whom to ask, and what. */
export function gatewayTarget(prompt: string): { person: string; ask: string } | undefined {
  const tagged = /(?:^|\s)@(?!claude)(\w[\w.-]*)[,:]?\s+([\s\S]+)/i.exec(prompt.trim());
  if (tagged) return { person: tagged[1]!, ask: tagged[2]!.trim().replace(/[.?!]+$/, '') };
  const m = /\bask (\w[\w.-]*?)(?:['’]s claude)?(?: to)?\s+([\s\S]+)/i.exec(prompt.trim());
  if (!m || /^(me|you|claude|it|them|him|her)$/i.test(m[1]!)) return undefined;
  return { person: m[1]!, ask: m[2]!.trim().replace(/[.?!]+$/, '') };
}

const TEST_SCHEMA = { type: 'object', required: ['passed', 'failed'], properties: { passed: { type: 'integer' }, failed: { type: 'integer' }, skipped: { type: 'integer' } } };

/** What a result says, pulled out of the delimited block (the demo only shows it back). */
function readResult(text: string): { summary: string; data?: unknown } | undefined {
  const block = /<task_result[^>]*>\n([\s\S]*?)\n<\/task_result>/.exec(text)?.[1];
  if (!block) return undefined;
  const summary = /summary:\n([\s\S]*?)(?:\n\ndata \(JSON\):|\n\nfiles|$)/.exec(block)?.[1]?.trim() ?? '';
  const raw = /data \(JSON\):\n([\s\S]*?)(?:\n\n|$)/.exec(block)?.[1];
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  return { summary, ...(data !== undefined ? { data } : {}) };
}

function tableOf(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const rows = Object.entries(data as Record<string, unknown>);
  return rows.length ? `\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${String(v)} |`).join('\n')}` : '';
}

/** The demo's Claude asks a friend's Claude (the gateway tools) and waits for the answer. */
async function mockAsk(input: AgentRunInput, bridge: RoomBridge, target: { person: string; ask: string }, pace: number): Promise<string> {
  const gw = bridge.gateway!;
  await sleep(400 * pace, input.signal);
  input.onEvent('tool', 'who_can');
  await sleep(300 * pace, input.signal);
  input.onEvent('tool', `ask_person ${target.person}${MORE}${JSON.stringify({ ask: target.ask })}`);
  let sent: string;
  try {
    sent = gw.askPerson({ person: target.person, ask: target.ask, summary: target.ask.length > 70 ? `${target.ask.slice(0, 69)}…` : target.ask, ...(/\btests?\b/i.test(target.ask) ? { expects: TEST_SCHEMA } : {}) });
  } catch (err) {
    return `I couldn't ask ${target.person}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const id = /Task (t_[\w-]+)/.exec(sent)?.[1];
  if (!id) return `I couldn't ask ${target.person}: ${sent}`;
  input.onEvent('tool', `wait_for ${id}`);
  const answer = await gw.waitFor(id, 120);
  const result = readResult(answer);
  if (!result) return `I asked ${target.person}; no answer yet. I'll pick it up here when it arrives.`;
  if (/^status: (declined|cancelled|failed)/m.test(answer)) return `${target.person} didn't do it: ${result.summary}`;
  return `${target.person}'s Claude says: ${result.summary}${tableOf(result.data)}`;
}

/** The demo's Claude bringing main up to date: the steps and the explanation, without touching git. */
async function mockSyncMain(input: AgentRunInput, target: { branch: string; upstream: string }, pace: number): Promise<string> {
  for (const step of ['git status', `git log --oneline --graph -15 ${target.branch} ${target.upstream}`, 'git stash push -u -m "before updating main"', `git merge ${target.upstream}`, 'git stash pop']) {
    await sleep(500 * pace, input.signal);
    input.onEvent('tool', `Bash ${step}`);
  }
  await sleep(400 * pace, input.signal);
  return `${target.branch} is up to date with ${target.upstream}. I set your uncommitted changes aside, merged the new commits (no conflicts), and put your changes back. Nothing was pushed.`;
}

export function createMockBackend(bridge: RoomBridge, pace = 1): AgentBackend {
  const context = new MockContext();
  return {
    nameTask: async (prompt) => {
      await new Promise((r) => setTimeout(r, 600 * pace));
      return slugify(prompt);
    },
    async run(original: AgentRunInput): Promise<string> {
      const stepper = original.onStep ? new MockStepper(original.prompt, original.onStep) : undefined;
      // The context window fills as Claude works (the meter moves live).
      const input = withGrowingContext(withSteps(original, stepper), context);
      try {
        return await runScript(input);
      } finally {
        stepper?.finish();
      }
    },
  };

  async function runScript(input: AgentRunInput): Promise<string> {
    const script = SCRIPTS.find((s) => s.match.test(input.prompt)) ?? FALLBACK;
    if (/^\/compact/.test(input.prompt.trim())) return context.compact(input, (ms) => sleep(ms * pace, input.signal));
    // Updating main (the one thing a main-folder run may change): what real Claude would report.
    if (input.place?.syncMain) return mockSyncMain(input, input.place.syncMain, pace);
    // A main folder is questions only: a change request moves to a new worktree, as real Claude is told to.
    if (input.place?.askOnly && WANTS_CHANGE.test(input.prompt)) {
      if (!input.continueInWorktree) return "This is the project's main folder, which is read-only. Ask the owner to continue in a new worktree.";
      await sleep(300 * pace, input.signal);
      input.onEvent('tool', 'continue_in_worktree');
      await input.continueInWorktree(input.prompt.trim());
      return 'Moving this to a new worktree; I’ll continue there.';
    }
    // Plan mode, and questions back to you, work in the demo too.
    if (input.plan) return mockPlan(input, pace);
    // A friend's Claude answered after this conversation's turn ended: carry on with it.
    if (/^\[klaud\] /.test(input.prompt)) {
      await sleep(500 * pace, input.signal);
      const result = readResult(input.prompt);
      return `Picking this back up: ${result?.summary ?? 'they answered.'}${tableOf(result?.data)}`;
    }
    // A friend's task: only what they asked (between <request> tags) can name someone to ask.
    const asked = /<request>\n([\s\S]*?)\n<\/request>/.exec(input.prompt)?.[1] ?? input.prompt;
    const gwTarget = bridge.gateway?.available() ? gatewayTarget(asked) : undefined;
    if (gwTarget) return mockAsk(input, bridge, gwTarget, pace);
    const remote = peerRunTarget(input.prompt, input.requesterName);
    if (remote && bridge.runOnPeer) return mockPeerRun(input, bridge, remote, pace);
    if (/\b(which|choose|pick)\b/i.test(input.prompt) && input.askUser) {
      await sleep(450 * pace, input.signal);
      input.onEvent('tool', 'Read src/server.ts');
      const answer = await input.askUser({
        kind: 'question',
        questions: [
          {
            question: 'Which session store should auth use?',
            header: 'Sessions',
            multiSelect: false,
            options: [
              { label: 'Signed cookies', description: 'no server state, simplest' },
              { label: 'Redis', description: 'shared across servers' },
              { label: 'Postgres', description: 'reuses the existing database' },
            ],
          },
        ],
      });
      const picked = answer.kind === 'answers' ? Object.values(answer.answers)[0] : undefined;
      return picked ? `Going with **${picked}**. I'll wire \`requireUser()\` to it next.` : "No preference, so I'll start with **signed cookies**: the simplest option.";
    }
    for (const step of script.steps) {
      await sleep((script.stepMs ?? 450) * pace, input.signal);
      input.onEvent('tool', step);
    }
    const subs = (script.subagents ?? []).map((s, i) => ({ ...s, id: `sub-${Date.now()}-${i}` }));
    for (const s of subs) input.onEvent('sub', JSON.stringify({ id: s.id, phase: 'start', title: s.title, kind: s.kind ?? 'agent' }));
    const longest = Math.max(0, ...subs.map((s) => s.steps.length));
    for (let i = 0; i < longest; i++) {
      await sleep(500 * pace, input.signal);
      for (const s of subs) {
        const step = s.steps[i];
        if (step) input.onEvent('sub', JSON.stringify({ id: s.id, phase: 'step', step }));
        if (i === s.steps.length - 1) input.onEvent('sub', JSON.stringify({ id: s.id, phase: 'done' }));
      }
    }
    if (script.report) await bridge.writeReport(script.report.title, script.report.markdown);
    await sleep(400 * pace, input.signal);
    const contextUsed = context.finish(input);
    input.onEvent('usage', JSON.stringify({ input: 18_000 + script.steps.length * 6_000, output: 2_400, cacheRead: contextUsed, cacheWrite: 9_000, cost: 0.21 + script.steps.length * 0.04 }));
    return script.answer;
  }
}

/** The run's events, also recorded as steps in detail (tool calls and sub-agents' steps). */
function withSteps(input: AgentRunInput, stepper: MockStepper | undefined): AgentRunInput {
  const background = new Set<string>();
  return {
    ...input,
    onEvent: (kind, raw) => {
      // The extra input a line may carry (see mock-steps.ts) is for the step's record, not the chat.
      const { line: text, more } = kind === 'tool' ? splitLine(raw) : { line: raw, more: {} };
      if (!stepper) return input.onEvent(kind, text);
      if (kind === 'tool') stepper.step(text, undefined, more);
      if (kind === 'sub') {
        try {
          const e = JSON.parse(text) as { id?: string; phase?: string; step?: string; kind?: string };
          if (e.id && e.phase === 'start' && e.kind === 'background') background.add(e.id);
          if (e.id && !background.has(e.id) && e.phase === 'step' && e.step) stepper.step(e.step, e.id);
          if (e.id && e.phase === 'done') stepper.close(e.id);
        } catch {
          // Not a sub-agent event we know.
        }
      }
      input.onEvent(kind, text);
    },
  };
}
