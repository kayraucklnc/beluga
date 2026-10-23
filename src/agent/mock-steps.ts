import { type StepRecord, thinkingTitle, wordsOf } from '../shared/steps.js';

/**
 * The demo's Claude in detail: for each canned step ("Bash npm test", "Read src/server.ts") the
 * input a real tool call would carry and believable output (terminal colours included), plus a
 * stretch of thinking before the first step, so opening a step in the demo shows what it would
 * with real Claude. Pure data and a small clock; no I/O.
 */

const ESC = '\u001b[';
const green = (s: string): string => `${ESC}32m${s}${ESC}39m`;
const red = (s: string): string => `${ESC}31m${s}${ESC}39m`;
const dim = (s: string): string => `${ESC}2m${s}${ESC}22m`;
const yellow = (s: string): string => `${ESC}33m${s}${ESC}39m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}22m`;

const FILES: Readonly<Record<string, string>> = {
  'src/server.ts': [
    "import express from 'express';",
    "import { payments } from './payments.js';",
    "import { webhooks } from './webhooks.js';",
    '',
    'const app = express();',
    'app.use(express.json());',
    '',
    '// TODO: add auth',
    "app.use('/api/payments', payments);",
    "app.use('/webhooks', webhooks);",
    '',
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    '',
    'app.listen(process.env.PORT ?? 3000);',
  ].join('\n'),
  'README.md': ['# demo-api', '', 'A small TypeScript API: payments and webhooks.', '', '## Setup', '', '```sh', 'npm install', 'npm test', '```', '', 'Open work is tracked in `NOTES.md`.'].join('\n'),
  'NOTES.md': ['# Notes', '', '- TODO: auth for /api/payments (sessions? cookies?)', '- webhook retries are not idempotent yet', '- deploy after auth lands'].join('\n'),
  'package.json': ['{', '  "name": "demo-api",', '  "type": "module",', '  "scripts": {', '    "dev": "tsx watch src/server.ts",', '    "test": "vitest run",', '    "lint": "eslint src"', '  },', '  "dependencies": { "express": "^5.1.0" }', '}'].join('\n'),
};

const AUTH_TS = [
  "import type { NextFunction, Request, Response } from 'express';",
  '',
  '/** Requests without a signed-in session stop here with a 401. */',
  'export function requireUser(req: Request, res: Response, next: NextFunction): void {',
  "  const session = req.signedCookies?.session;",
  '  if (!session) {',
  "    res.status(401).json({ error: 'Sign in first' });",
  '    return;',
  '  }',
  '  next();',
  '}',
].join('\n');

const numbered = (text: string): string =>
  text
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join('\n');

const BASH: ReadonlyArray<{ match: RegExp; description: string; output: string; error?: boolean }> = [
  {
    match: /^npm test -- --coverage/,
    description: 'Run the tests with coverage',
    output: [
      ` ${green('✓')} src/auth.test.ts ${dim('(3 tests)')} 12ms`,
      ` ${green('✓')} src/payments.test.ts ${dim('(14 tests)')} 41ms`,
      ` ${green('✓')} src/webhooks.test.ts ${dim('(10 tests)')} 33ms`,
      '',
      `${dim('-------------|---------|----------|---------|')}`,
      `File         | % Stmts | % Branch | % Funcs |`,
      `${dim('-------------|---------|----------|---------|')}`,
      `All files    |   ${green('87.1')}  |   ${yellow('78.4')}   |   ${green('91.2')}  |`,
      ` auth.ts     |   ${green('100')}   |   ${green('100')}    |   ${green('100')}   |`,
      ` payments.ts |   ${yellow('71.3')}  |   ${red('58.0')}   |   ${yellow('80.0')}  |`,
      ` webhooks.ts |   ${green('90.6')}  |   ${green('85.7')}   |   ${green('100')}   |`,
    ].join('\n'),
  },
  {
    match: /^npm test/,
    description: 'Run the test suite',
    output: [
      '',
      ` ${bold('RUN')}  v3.2.4 /Users/kay/demo-api`,
      '',
      ` ${green('✓')} src/auth.test.ts ${dim('(3 tests)')} 12ms`,
      ` ${green('✓')} src/payments.test.ts ${dim('(14 tests)')} 41ms`,
      ` ${green('✓')} src/webhooks.test.ts ${dim('(7 tests)')} 33ms`,
      '',
      ` ${dim('Test Files')}  ${green('3 passed')} (3)`,
      `      ${dim('Tests')}  ${green('24 passed')} (24)`,
      `   ${dim('Start at')}  10:42:07`,
      `   ${dim('Duration')}  412ms`,
    ].join('\n'),
  },
  {
    match: /^npm run lint/,
    description: 'Lint the source',
    error: true,
    output: [`${bold('src/payments.ts')}`, `  31:7  ${red('error')}  'retries' is assigned a value but never used  ${dim('no-unused-vars')}`, '', red('✖ 1 problem (1 error, 0 warnings)'), '', 'Exit code 1'].join('\n'),
  },
  {
    match: /^git diff .*--stat/,
    description: 'See what changed against main',
    output: [` src/auth.ts       | 11 ${green('+++++++++++')}`, ` src/auth.test.ts  | 38 ${green('++++++++++++++++++++')}`, ` src/server.ts     |  4 ${green('++')}${red('--')}`, ' 3 files changed, 51 insertions(+), 2 deletions(-)'].join('\n'),
  },
  {
    match: /^git log/,
    description: 'Recent commits',
    output: [`${yellow('9f2c1ab')} payments: retry failed charges`, `${yellow('41d0e7c')} webhooks: verify signatures`, `${yellow('c3b8a02')} server: health check`, `${yellow('7a51f9e')} first commit`].join('\n'),
  },
  {
    match: /^git status/,
    description: 'Check the working tree',
    output: ['On branch main', "Your branch is behind 'origin/main' by 3 commits.", '', 'Changes not staged for commit:', `\t${red('modified:   NOTES.md')}`].join('\n'),
  },
];

function bashOf(command: string): { input: Record<string, unknown>; output: string; error?: boolean } {
  const known = BASH.find((b) => b.match.test(command));
  return { input: { command, description: known?.description ?? `Run ${command.split(' ')[0]}` }, output: known?.output ?? '', ...(known?.error ? { error: true } : {}) };
}

const unquote = (s: string): string => s.replace(/^"(.*)"$/, '$1');

/** Beluga's tools in the demo's lines: which input the line's words are. */
const KLAUD_ARG: Readonly<Record<string, string>> = { ask_person: 'person', wait_for: 'task', run_on_peer: 'command', write_report: 'title', continue_in_worktree: 'task' };
const KLAUD_OUT: Readonly<Record<string, (arg: string) => string>> = {
  who_can: () => JSON.stringify([{ name: 'bob', status: 'online', offers: ['project', 'shell'] }, { name: 'mia', status: 'away', offers: ['project'] }], null, 2),
  ask_person: (who) => `Task t_demo sent to ${who}'s Claude. Call wait_for to get the answer.`,
  wait_for: () => 'status: done\nsummary:\nAll 24 tests pass on their Mac.',
  list_peers: () => JSON.stringify([{ name: 'bob', you: false, agent: true }], null, 2),
  write_report: (title) => `Saved .beluga/reports/${title.toLowerCase().replace(/\W+/g, '-')}.md`,
};

/** A demo line can carry more input than its words: "ask_person bob\u0000{\"ask\":\"…\"}". */
export const MORE = '\u0000';
export function splitLine(line: string): { line: string; more: Record<string, unknown> } {
  const at = line.indexOf(MORE);
  if (at < 0) return { line, more: {} };
  try {
    return { line: line.slice(0, at), more: JSON.parse(line.slice(at + 1)) as Record<string, unknown> };
  } catch {
    return { line: line.slice(0, at), more: {} };
  }
}

/** A canned step line → the tool call it stands for and what it returned. */
export function mockTool(step: string, cwd = '/Users/kay/demo-api'): { tool: string; input: Record<string, unknown>; output: string; error?: boolean } {
  const space = step.indexOf(' ');
  const name = space < 0 ? step : step.slice(0, space);
  const arg = space < 0 ? '' : step.slice(space + 1).trim();
  const abs = (p: string): string => `${cwd}/${p}`;
  switch (name) {
    case 'Bash': {
      const b = bashOf(arg);
      return { tool: 'Bash', ...b };
    }
    case 'Read':
      return { tool: 'Read', input: { file_path: abs(arg) }, output: numbered(FILES[arg] ?? `// ${arg}\nexport {};`) };
    case 'Grep': {
      const [pattern, path] = [unquote(arg.split(' ')[0] ?? ''), arg.split(' ')[1]];
      const hits = [`src/server.ts:8:// ${pattern === 'TODO' ? 'TODO: add auth' : `${pattern} check goes here`}`, `NOTES.md:3:- ${pattern === 'TODO' ? 'TODO: auth for /api/payments' : `${pattern}: not started`}`];
      return { tool: 'Grep', input: { pattern, ...(path ? { path: abs(path) } : {}), output_mode: 'content', '-n': true }, output: hits.join('\n') };
    }
    case 'Glob':
      return { tool: 'Glob', input: { pattern: arg }, output: [abs('src/server.ts'), abs('src/payments.ts'), abs('src/webhooks.ts'), abs('src/auth.ts')].join('\n') };
    case 'Write':
      return { tool: 'Write', input: { file_path: abs(arg), content: arg.endsWith('auth.ts') ? AUTH_TS : `// ${arg}\n` }, output: `File created successfully at: ${abs(arg)}` };
    case 'Edit':
      return {
        tool: 'Edit',
        input: { file_path: abs(arg), old_string: "import { webhooks } from './webhooks.js';\n\nconst app = express();\napp.use(express.json());\n\n// TODO: add auth\napp.use('/api/payments', payments);", new_string: "import { webhooks } from './webhooks.js';\nimport { requireUser } from './auth.js';\n\nconst app = express();\napp.use(express.json());\n\napp.use('/api/payments', requireUser, payments);" },
        output: `The file ${abs(arg)} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file.`,
      };
    default: {
      const key = KLAUD_ARG[name];
      return { tool: `mcp__beluga__${name}`, input: key && arg ? { [key]: arg } : {}, output: KLAUD_OUT[name]?.(arg) ?? 'ok' };
    }
  }
}

/** What the demo's Claude "thought" before starting, from what it was asked. */
export function mockThinking(prompt: string): string {
  const ask = prompt.replace(/\s+/g, ' ').trim().slice(0, 120);
  return [
    `They asked: "${ask}". Before answering I want to see how the project is laid out, so I'm not guessing.`,
    '',
    'Plan:',
    '1. Skim `README.md` and `NOTES.md` for what is already known (the notes mention auth and webhook retries).',
    '2. Look at `src/server.ts`, since every route is wired there.',
    '3. Run the tests if anything changes, so I can say what still passes.',
    '',
    "I'll start with the files and keep the answer short.",
  ].join('\n');
}

/**
 * Turns the demo's canned steps into records as they happen: the previous step ends (with its
 * output) when the next one starts, or when the run ends.
 */
export class MockStepper {
  private readonly open = new Map<string, StepRecord>();
  private n = 0;
  private began = Date.now();
  private thought = false;

  constructor(
    private readonly prompt: string,
    private readonly emit: (record: StepRecord) => void,
  ) {}

  /** A main-thread step (`parent`: a sub-agent's step). */
  step(line: string, parent?: string, more: Record<string, unknown> = {}): void {
    if (!this.thought && !parent) this.think();
    this.close(parent ?? '');
    const made = mockTool(line);
    const t = { ...made, input: { ...made.input, ...more } };
    const id = `toolu_demo_${++this.n}`;
    const record: StepRecord = { id, kind: 'tool', tool: t.tool, title: line, ...wordsOf(t.tool, t.input, '/Users/kay/demo-api'), status: 'running', startedAt: Date.now(), input: t.input, ...(parent ? { parent } : {}) };
    this.open.set(parent ?? '', record);
    this.pending.set(id, t);
    this.emit(record);
  }

  /** Close the open step of a thread (its output arrives). */
  close(thread: string): void {
    const rec = this.open.get(thread);
    if (!rec) return;
    this.open.delete(thread);
    const t = this.pending.get(rec.id);
    this.pending.delete(rec.id);
    const now = Date.now();
    this.emit({ ...rec, status: t?.error ? 'error' : 'done', endedAt: now, durationMs: now - rec.startedAt, output: t?.output ?? '', ...(t?.error ? { isError: true } : {}) });
  }

  /** Everything still open ends. */
  finish(): void {
    for (const thread of [...this.open.keys()]) this.close(thread);
  }

  private readonly pending = new Map<string, ReturnType<typeof mockTool>>();

  private think(): void {
    this.thought = true;
    const now = Date.now();
    this.emit({ id: 'think-1', kind: 'thinking', title: thinkingTitle(now - this.began, false), status: 'done', startedAt: this.began, endedAt: now, durationMs: now - this.began, text: mockThinking(this.prompt) });
  }
}
