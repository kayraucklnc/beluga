import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PrCheck, PullRequest } from '../core/work-store.js';
import { klaudHome } from './store.js';
export { describePr } from '../shared/format.js';

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

/** The GitHub CLI to run: `gh`, or KLAUD_GH (the Mac app's end-to-end tests point it at a stand-in). */
const gh = (): string => process.env.KLAUD_GH || 'gh';

let ghReady: Promise<boolean> | undefined;
/** Whether the GitHub CLI is installed and signed in (checked once). */
export function hasGh(): Promise<boolean> {
  ghReady ??= run(gh(), ['auth', 'status'], process.cwd(), 8000).then(
    () => true,
    () => false,
  );
  return ghReady;
}

/** One entry of gh's statusCheckRollup: a CheckRun (Actions job) or a StatusContext (commit status). */
interface GhCheck {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly workflowName?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
  readonly detailsUrl?: string;
  readonly targetUrl?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** Fold gh's statusCheckRollup into one word. */
export function checksState(checks: readonly GhCheck[] | undefined): PullRequest['checks'] {
  if (!checks?.length) return 'none';
  const states = checks.map((c) => (c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s))) return 'failing';
  if (states.some((s) => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED', ''].includes(s))) return 'pending';
  return 'passing';
}

/** At most this many checks are kept per PR (a matrix build can have hundreds). */
const MAX_CHECKS = 100;
/** GitHub's "not set" time for a check that hasn't started or finished. */
const time = (t: string | undefined): string | undefined => (t && !t.startsWith('0001-') ? t : undefined);

/** Each check in gh's statusCheckRollup, the same shape for Actions jobs and commit statuses. */
export function parseChecks(checks: readonly GhCheck[] | undefined): PrCheck[] {
  return (checks ?? []).slice(0, MAX_CHECKS).map((c): PrCheck => {
    const status = (c.status ?? '').toUpperCase();
    const commit = (c.state ?? '').toUpperCase();
    const isStatus = c.__typename === 'StatusContext' || (!c.status && Boolean(c.state));
    const state: PrCheck['state'] = isStatus
      ? commit === 'PENDING' ? 'in_progress' : commit === 'EXPECTED' || !commit ? 'queued' : 'completed'
      : status === 'COMPLETED' || (!status && c.conclusion) ? 'completed' : status === 'IN_PROGRESS' ? 'in_progress' : 'queued';
    const conclusion = state !== 'completed' ? undefined : isStatus ? commit.toLowerCase() : (c.conclusion ?? '').toLowerCase() || undefined;
    const url = c.detailsUrl || c.targetUrl;
    const startedAt = time(c.startedAt);
    const completedAt = state === 'completed' ? time(c.completedAt) : undefined;
    return {
      name: c.name || c.context || 'check',
      ...(c.workflowName ? { workflow: c.workflowName } : {}),
      state,
      ...(conclusion ? { conclusion } : {}),
      ...(url ? { url } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAt ? { completedAt } : {}),
    };
  });
}

interface GhPr {
  number?: number;
  url?: string;
  state?: string;
  title?: string;
  isDraft?: boolean;
  statusCheckRollup?: GhCheck[];
  reviewDecision?: string;
  headRefName?: string;
  mergeable?: string;
  autoMergeRequest?: unknown;
}

function toPr(raw: GhPr): PullRequest | undefined {
  if (typeof raw.number !== 'number' || typeof raw.url !== 'string') return undefined;
  const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN';
  const review = raw.reviewDecision === 'APPROVED' || raw.reviewDecision === 'CHANGES_REQUESTED' || raw.reviewDecision === 'REVIEW_REQUIRED' ? raw.reviewDecision : undefined;
  const checkRuns = parseChecks(raw.statusCheckRollup);
  const open = state === 'OPEN';
  return {
    number: raw.number,
    url: raw.url,
    state,
    title: raw.title ?? '',
    draft: Boolean(raw.isDraft),
    checks: checksState(raw.statusCheckRollup),
    ...(checkRuns.length ? { checkRuns } : {}),
    ...(review ? { review } : {}),
    ...(open && raw.mergeable === 'CONFLICTING' ? { conflicts: true } : {}),
    ...(open && raw.autoMergeRequest ? { autoMerge: true } : {}),
  };
}

/** Parse `gh pr view --json …` output. */
export function parsePr(json: string): PullRequest | undefined {
  try {
    return toPr(JSON.parse(json) as GhPr);
  } catch {
    return undefined;
  }
}

/**
 * Parse `gh pr list --state all --json …` output into each branch's PR: its open one, or else
 * the newest. Undefined when gh's answer isn't a list.
 */
export function parsePrList(json: string): Map<string, PullRequest> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const out = new Map<string, PullRequest>();
  for (const item of raw as GhPr[]) {
    const pr = item && typeof item.headRefName === 'string' ? toPr(item) : undefined;
    if (!pr) continue;
    const had = out.get(item.headRefName!);
    const open = (p: PullRequest): number => (p.state === 'OPEN' ? 1 : 0);
    if (!had || open(pr) > open(had) || (open(pr) === open(had) && pr.number > had.number)) out.set(item.headRefName!, pr);
  }
  return out;
}

const PR_FIELDS = 'number,url,state,title,isDraft,statusCheckRollup,reviewDecision,mergeable,autoMergeRequest';
/** How many PRs one `gh pr list` asks for. */
export const PR_LIST_LIMIT = 60;

/** The pull request for a branch, if there is one. Throws when gh couldn't tell (offline, rate limit…). */
export async function findPr(dir: string, branch: string): Promise<PullRequest | undefined> {
  if (!(await hasGh())) return undefined;
  try {
    return parsePr(await run(gh(), ['pr', 'view', branch, '--json', PR_FIELDS], dir));
  } catch (err) {
    if (err instanceof Error && /no pull requests? found/i.test(err.message)) return undefined;
    throw err;
  }
}

/**
 * The repository's recent pull requests (any state) by branch, in one call: cheaper than one
 * `gh pr view` per worktree. Throws when gh couldn't tell.
 */
export async function listPrs(dir: string): Promise<{ prs: Map<string, PullRequest>; full: boolean }> {
  if (!(await hasGh())) return { prs: new Map(), full: false };
  const out = await run(gh(), ['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', `${PR_FIELDS},headRefName`], dir, 30_000);
  const prs = parsePrList(out);
  if (!prs) throw new Error('gh pr list gave something unexpected');
  // A full page may have left out an older PR: those branches are looked up one by one.
  const count = (JSON.parse(out) as unknown[]).length;
  return { prs, full: count >= PR_LIST_LIMIT };
}

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface MergeOptions {
  readonly method: MergeMethod;
  /** Merge once the required checks and reviews pass (GitHub's auto-merge), not now. */
  readonly auto?: boolean;
  /** Delete the branch on GitHub once merged (the worktree keeps its local branch). */
  readonly deleteBranch?: boolean;
}

/** Why GitHub said no to a merge. */
export type MergeProblem = 'conflicts' | 'reviews' | 'checks' | 'blocked' | 'auto_off' | 'method' | 'draft' | 'closed' | 'permission' | 'other';

const METHOD_NAME: Record<MergeMethod, string> = { squash: 'Squash merging', merge: 'Merge commits', rebase: 'Rebase merging' };

/** gh's error from `gh pr merge`, as what went wrong and what to do about it. */
export function explainMergeError(error: string, method: MergeMethod = 'squash'): { reason: MergeProblem; message: string } {
  const text = error.trim();
  const say = (reason: MergeProblem, message: string) => ({ reason, message });
  if (/conflict|cannot be cleanly created|mergeable state is dirty/i.test(text)) return say('conflicts', 'This branch conflicts with the base branch. Solve the conflict (or ask Claude to), push, then merge.');
  if (/auto.?merge.*(not allowed|disabled|not enabled|isn.t enabled)|enablePullRequestAutoMerge|auto merge is not allowed/i.test(text)) return say('auto_off', "Auto-merge is off for this repository. Turn on “Allow auto-merge” in its GitHub settings, or merge once the checks pass.");
  if (/draft/i.test(text)) return say('draft', 'This pull request is still a draft. Mark it ready for review on GitHub first.');
  if (/approv|review(s)? (is |are )?required|changes requested|review_required/i.test(text)) return say('reviews', 'GitHub needs an approving review before this can merge. Ask for one, or use “Merge When Checks Pass” to merge once it’s approved.');
  if (/status check|checks? (are |is )?(failing|pending|expected|in progress)|required check/i.test(text)) return say('checks', 'Required checks haven’t passed yet. Wait for them, or use “Merge When Checks Pass”.');
  if (/base branch policy|protected branch|branch protection|repository rule|not mergeable/i.test(text)) return say('blocked', 'The branch’s rules don’t allow merging yet (a review or checks are still needed). Use “Merge When Checks Pass” to merge once they’re met.');
  if (/not allowed|disabled|is not permitted/i.test(text) && /merge|squash|rebase/i.test(text)) return say('method', `${METHOD_NAME[method]} isn’t allowed on this repository. Pick another way to merge from the menu.`);
  if (/already (been )?merged|is closed|was closed|not open/i.test(text)) return say('closed', 'This pull request isn’t open anymore.');
  if (/permission|not authorized|forbidden|HTTP 403|must have (write|admin|push)/i.test(text)) return say('permission', 'Your GitHub account can’t merge into this repository.');
  return say('other', `GitHub didn’t merge it: ${text.split('\n').find((l) => l.trim())?.trim() ?? 'no reason given'}`);
}

/** Merge a pull request on GitHub (`gh pr merge`), or ask GitHub to once its requirements pass (`auto`). Throws gh's error. */
export async function mergePr(dir: string, number: number, opts: MergeOptions): Promise<void> {
  await run(gh(), ['pr', 'merge', String(number), `--${opts.method}`, ...(opts.auto ? ['--auto'] : [])], dir, 60_000);
}

/**
 * Delete a merged branch on GitHub. Not gh's --delete-branch: that also deletes the local branch
 * and checks out the base, which a worktree can't (the base is checked out in the main folder).
 */
export async function deleteRemoteBranch(dir: string, branch: string, remote = 'origin'): Promise<void> {
  await run('git', ['push', remote, '--delete', branch], dir, 30_000);
}

/**
 * What this computer last knew the branch to be on origin (its remote-tracking ref), read straight
 * from the repository without running git. It changes when the branch is pushed (or fetched after
 * someone else pushed): the moment a PR is worth looking at again.
 */
export function remoteRef(dir: string, branch: string, remote = 'origin'): string | undefined {
  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  };
  // A linked worktree's `.git` is a file pointing at its git dir, whose `commondir` leads to the shared refs.
  const link = read(path.join(dir, '.git'))?.match(/^gitdir:\s*(.+)$/m)?.[1];
  const gitDir = link ? path.resolve(dir, link) : path.join(dir, '.git');
  const commonDir = read(path.join(gitDir, 'commondir'));
  const common = commonDir ? path.resolve(gitDir, commonDir) : gitDir;
  const name = `refs/remotes/${remote}/${branch}`;
  const loose = read(path.join(common, ...name.split('/')));
  if (loose) return loose;
  // `git gc` / `git pack-refs` moves refs into packed-refs: "<sha> <ref>" lines (^ lines peel tags).
  for (const line of read(path.join(common, 'packed-refs'))?.split('\n') ?? []) {
    const [sha, ref] = line.trim().split(' ');
    if (ref === name && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  return undefined;
}
