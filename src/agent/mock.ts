import type { AgentBackend, AgentRunInput, RoomBridge } from './types.js';
import { slugify } from './namer.js';

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
    steps: ['Read src/server.ts'],
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
    steps: ['Read package.json'],
    subagents: [{ title: 'npm test --watch', steps: ['24 passed', '24 passed'], kind: 'background' }],
    answer: 'All **24 tests** pass. Coverage is 87%; `payments.ts` is the least covered file.',
  },
];

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
  input.onEvent('tool', `run_on_peer ${target.command}`);
  const result = await bridge.runOnPeer!(target.peer, target.command, { why: 'to check before I change anything' }).catch((err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`);
  const head = result.split('\n')[0] ?? '';
  if (/did not run|failed:/.test(head)) return `I couldn't run \`${target.command}\` on ${target.peer}'s computer: ${head.replace(/^.*?: /, '')}`;
  const passed = /(\d+) passed \(/.exec(result.split('\n').filter((l) => /Tests/.test(l)).join('\n'))?.[1];
  return `Ran \`${target.command}\` on ${target.peer}'s computer. ${head}.${passed ? ` **${passed} tests pass.**` : ''}`;
}

export function createMockBackend(bridge: RoomBridge, pace = 1): AgentBackend {
  let contextUsed = 52_000;
  return {
    nameTask: async (prompt) => {
      await new Promise((r) => setTimeout(r, 600 * pace));
      return slugify(prompt);
    },
    async run(input: AgentRunInput): Promise<string> {
      const script = SCRIPTS.find((s) => s.match.test(input.prompt)) ?? FALLBACK;
      if (/^\/compact/.test(input.prompt.trim())) {
        await sleep(900 * pace, input.signal);
        input.onEvent('compact', JSON.stringify({ pre: 168_000, post: 21_000, trigger: 'manual' }));
        return 'Compacted the conversation. I kept the plan, decisions so far, and open TODOs.';
      }
      // Plan mode, and questions back to you, work in the demo too.
      if (input.plan) return mockPlan(input, pace);
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
      contextUsed = Math.min(195_000, contextUsed + 34_000 + script.steps.length * 9_000);
      input.onEvent('context', JSON.stringify({ used: contextUsed, window: 200_000 }));
      input.onEvent('usage', JSON.stringify({ input: 18_000 + script.steps.length * 6_000, output: 2_400, cacheRead: contextUsed, cacheWrite: 9_000, cost: 0.21 + script.steps.length * 0.04 }));
      return script.answer;
    },
  };
}
