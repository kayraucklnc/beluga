import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PullRequest } from '../core/work-store.js';
import { klaudHome } from './store.js';

/**
 * What Claude does when you click PR. Edit it in Settings → Claude → Pull request
 * instructions (saved to ~/.klaud/prompts/pull-request.md). {{branch}}, {{base}},
 * {{baseBranch}} and {{project}} are filled in.
 */
export const DEFAULT_PR_PROMPT = `Open a pull request for the work in this workspace.

1. Look at everything that changed compared to {{base}} (git log {{base}}..HEAD and git diff {{base}}).
2. If there are uncommitted changes that belong to this work, commit them with a clear conventional-commit
   message. Never commit secrets, .env files or unrelated changes.
3. Push {{branch}} to origin (set the upstream).
4. Write the pull request so a reviewer understands it in 30 seconds:
   - Title: short and imperative, under 70 characters (for example "Add session auth to the payments API").
   - Description, short and easy to read:
     ## What
     2 to 4 bullets on what changed.
     ## Why
     One or two sentences on the problem it solves.
     ## How to test
     The commands or steps to check it.
     Mention anything risky, unfinished or worth a closer look.
5. Create it with: gh pr create --base {{baseBranch}} --head {{branch}} --title "<title>" --body-file <file>
   (write the body to a temporary file first). If a pull request for {{branch}} already exists,
   push the new commits and update its title and description with gh pr edit instead.
6. Reply with the pull request URL and a one-paragraph explanation of the change.`;

export const prPromptFile = (): string => path.join(klaudHome(), 'prompts', 'pull-request.md');

/** Your customized instructions, if you saved any. */
export function customPrPrompt(file = prPromptFile()): string | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text && text !== DEFAULT_PR_PROMPT.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Make sure the file exists (with the built-in text) so it can be opened in an editor. */
export function ensurePrPromptFile(file = prPromptFile()): string {
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${DEFAULT_PR_PROMPT}\n`);
  }
  return file;
}

export function resetPrPrompt(file = prPromptFile()): void {
  rmSync(file, { force: true });
}

export interface PrContext {
  readonly branch: string;
  readonly base: string;
  readonly project: string;
  /** Project-specific additions from klaud.json. */
  readonly projectPrompt?: string;
  /** What you typed for this one PR ("/pr mention the migration"). */
  readonly extra?: string;
}

/** The full prompt Claude gets for one PR. */
export function buildPrPrompt(ctx: PrContext, template = customPrPrompt() ?? DEFAULT_PR_PROMPT): string {
  const baseBranch = ctx.base.replace(/^origin\//, '');
  const filled = template.replaceAll('{{branch}}', ctx.branch).replaceAll('{{baseBranch}}', baseBranch).replaceAll('{{base}}', ctx.base).replaceAll('{{project}}', ctx.project);
  const project = ctx.projectPrompt?.trim() ? `\n\nProject guidelines for pull requests (from klaud.json):\n${ctx.projectPrompt.trim()}` : '';
  const extra = ctx.extra?.trim() ? `\n\nFor this pull request, also: ${ctx.extra.trim()}` : '';
  return `${filled}${project}${extra}`;
}

/** Ask Claude to fix the failing checks on a PR. */
export const fixChecksPrompt = (pr: PullRequest): string =>
  `The checks on pull request #${pr.number} (${pr.url}) are failing. Use gh pr checks ${pr.number} and gh run view --log-failed to find out why, fix it, run the tests, commit and push. Then say what was wrong.`;

const run = (cmd: string, args: readonly string[], cwd: string, timeoutMs = 20_000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
  });

let ghReady: Promise<boolean> | undefined;
/** Whether the GitHub CLI is installed and signed in (checked once). */
export function hasGh(): Promise<boolean> {
  ghReady ??= run('gh', ['auth', 'status'], process.cwd(), 8000).then(
    () => true,
    () => false,
  );
  return ghReady;
}

interface GhCheck {
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
}

/** Fold gh's statusCheckRollup into one word. */
export function checksState(checks: readonly GhCheck[] | undefined): PullRequest['checks'] {
  if (!checks?.length) return 'none';
  const states = checks.map((c) => (c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s))) return 'failing';
  if (states.some((s) => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED', ''].includes(s))) return 'pending';
  return 'passing';
}

/** Parse `gh pr view --json …` output. */
export function parsePr(json: string): PullRequest | undefined {
  try {
    const raw = JSON.parse(json) as { number?: number; url?: string; state?: string; title?: string; isDraft?: boolean; statusCheckRollup?: GhCheck[]; reviewDecision?: string };
    if (typeof raw.number !== 'number' || typeof raw.url !== 'string') return undefined;
    const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN';
    const review = raw.reviewDecision === 'APPROVED' || raw.reviewDecision === 'CHANGES_REQUESTED' || raw.reviewDecision === 'REVIEW_REQUIRED' ? raw.reviewDecision : undefined;
    return { number: raw.number, url: raw.url, state, title: raw.title ?? '', draft: Boolean(raw.isDraft), checks: checksState(raw.statusCheckRollup), ...(review ? { review } : {}) };
  } catch {
    return undefined;
  }
}

/** The pull request for a branch, if there is one. Throws when gh couldn't tell (offline, rate limit…). */
export async function findPr(dir: string, branch: string): Promise<PullRequest | undefined> {
  if (!(await hasGh())) return undefined;
  try {
    return parsePr(await run('gh', ['pr', 'view', branch, '--json', 'number,url,state,title,isDraft,statusCheckRollup,reviewDecision'], dir));
  } catch (err) {
    if (err instanceof Error && /no pull requests? found/i.test(err.message)) return undefined;
    throw err;
  }
}

/** "PR #12 · checks passing" */
export function describePr(pr: PullRequest): string {
  if (pr.state === 'MERGED') return `PR #${pr.number} merged`;
  if (pr.state === 'CLOSED') return `PR #${pr.number} closed`;
  const checks = pr.checks === 'none' ? '' : ` · checks ${pr.checks}`;
  const review = pr.review === 'APPROVED' ? ' · approved' : pr.review === 'CHANGES_REQUESTED' ? ' · changes requested' : '';
  return `PR #${pr.number}${pr.draft ? ' (draft)' : ''}${checks}${review}`;
}
