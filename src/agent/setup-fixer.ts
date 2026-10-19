import { query } from '@anthropic-ai/claude-agent-sdk';

const FIX_TIMEOUT_MS = 90_000;
const OUTPUT_CHARS = 4000;
const MAX_COMMAND = 2000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** What a project's setup should be: a command to run in new worktrees, or nothing at all. */
export type SetupFix = { readonly command: string } | { readonly none: true };

/** The answer out of what the model said: its last `SETUP:` line, `none` or one command. */
export function parseSetupFix(raw: string): SetupFix | undefined {
  const line = raw
    .trim()
    .split('\n')
    .reverse()
    .map((l) => l.trim().replace(/^`+|`+$/g, ''))
    .find((l) => /^SETUP:/i.test(l));
  const answer = line?.replace(/^SETUP:\s*/i, '').replace(/^`+|`+$/g, '').trim();
  if (!answer) return undefined;
  if (/^none\.?$/i.test(answer)) return { none: true };
  return answer.length <= MAX_COMMAND ? { command: answer } : undefined;
}

/**
 * A worktree's setup failed: a model looks at the project's files (read-only, no commands) and
 * the failure, and says what the setup should be, or that it needs none. Undefined on any trouble.
 */
export async function fixSetup(dir: string, failed: string, output: string, opts: { claudePath?: string; model?: string } = {}): Promise<SetupFix | undefined> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), FIX_TIMEOUT_MS);
  timer.unref();
  const tail = output.replace(ANSI, '').slice(-OUTPUT_CHARS);
  try {
    const q = query({
      prompt: `The setup command for new worktrees of this project failed.\n\nCommand: ${failed}\nOutput (end):\n"""\n${tail}\n"""\n\nLook at the project's files and decide the right setup command (installing dependencies so the project can run), or that it needs no setup.`,
      options: {
        cwd: dir,
        model: opts.model ?? 'sonnet',
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep'],
        maxTurns: 8,
        settingSources: [],
        persistSession: false,
        abortController,
        systemPrompt:
          "You fix the setup command a git worktree runs once when it's created. Be quick: look at lockfiles and manifests only. Prefer the package manager the project's lockfile belongs to. If nothing needs installing, the answer is none. End with exactly one line: `SETUP: <one shell command>` or `SETUP: none`.",
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') return parseSetupFix(msg.result);
    }
  } catch {
    // No fix: the failure stands.
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}
