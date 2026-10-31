import type { PrComment, PrConversation, PrReview, PrThread } from '../core/work-store.js';
import { runGh } from './pr.js';

/**
 * A pull request's conversation through the GitHub CLI: its comments, its reviews and its threads
 * on lines of code (in one GraphQL call), and your answers: a comment, a reply in a thread, a
 * thread resolved or opened again. gh fills {owner} and {repo} from the worktree's origin.
 */

/** The longest comment Beluga posts. */
export const MAX_PR_COMMENT = 60_000;
/** How many of each GraphQL reads (the newest). */
const PAGE = 100;

export const CONVERSATION_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { number url
    comments(last: ${PAGE}) { totalCount nodes { id author { login } body createdAt url } }
    reviews(last: ${PAGE}) { totalCount nodes { id author { login } body state submittedAt url } }
    reviewThreads(last: ${PAGE}) { totalCount nodes { id path line startLine originalLine originalStartLine isResolved isOutdated
      comments(first: ${PAGE}) { nodes { id author { login } body createdAt url diffHunk } } } }
  } }
}`;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const nodes = (v: unknown): Raw[] => (Array.isArray(obj(v).nodes) ? (obj(v).nodes as unknown[]).map(obj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);
const time = (v: unknown): number => Date.parse(str(v)) || 0;

function comment(raw: Raw, me: string, at = raw.createdAt): PrComment | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  const author = str(obj(raw.author).login) || 'ghost';
  return { id, author, body: str(raw.body), at: time(at), url: str(raw.url), ...(me && author === me ? { mine: true } : {}) };
}

const REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

/** Parse the answer to CONVERSATION_QUERY; undefined when it isn't one. */
export function parseConversation(json: string): PrConversation | undefined {
  let raw: Raw;
  try {
    raw = obj(JSON.parse(json));
  } catch {
    return undefined;
  }
  const data = obj(raw.data);
  const pr = obj(obj(data.repository).pullRequest);
  if (typeof pr.number !== 'number') return undefined;
  const me = str(obj(data.viewer).login);
  const comments = nodes(pr.comments).flatMap((c) => comment(c, me) ?? []);
  // A review is worth showing for what it decided or said; one with only line comments is its threads.
  const reviews = nodes(pr.reviews).flatMap((r): PrReview[] => {
    const state = str(r.state);
    const c = comment(r, me, r.submittedAt);
    if (!c || !REVIEW_STATES.has(state) || (state === 'COMMENTED' && !c.body.trim())) return [];
    return [{ ...c, state: state as PrReview['state'] }];
  });
  const threads = nodes(pr.reviewThreads).flatMap((t): PrThread[] => {
    const id = str(t.id);
    const list = nodes(t.comments);
    const thread = list.flatMap((c) => comment(c, me) ?? []);
    if (!id || !thread.length) return [];
    const line = num(t.line);
    const startLine = num(t.startLine);
    const originalLine = num(t.originalLine);
    const originalStartLine = num(t.originalStartLine);
    const diffHunk = str(list[0]?.diffHunk);
    return [
      {
        id,
        path: str(t.path),
        ...(line ? { line } : {}),
        ...(startLine && startLine !== line ? { startLine } : {}),
        ...(originalLine ? { originalLine } : {}),
        ...(originalStartLine && originalStartLine !== originalLine ? { originalStartLine } : {}),
        ...(diffHunk ? { diffHunk } : {}),
        resolved: t.isResolved === true,
        outdated: t.isOutdated === true,
        comments: thread,
      },
    ];
  });
  const total = (v: unknown): number => (typeof obj(v).totalCount === 'number' ? (obj(v).totalCount as number) : 0);
  const more = total(pr.comments) > PAGE || total(pr.reviews) > PAGE || total(pr.reviewThreads) > PAGE;
  return { number: pr.number, url: str(pr.url), comments, reviews, threads, ...(more ? { more: true } : {}) };
}

/** Everything said on the PR. Throws gh's error. */
export async function prConversation(dir: string, number: number): Promise<PrConversation> {
  const out = await runGh(['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-F', `number=${number}`, '-f', `query=${CONVERSATION_QUERY}`], dir);
  const conversation = parseConversation(out);
  if (!conversation) throw new Error('GitHub gave something unexpected for the pull request’s comments');
  return conversation;
}

const clean = (body: string): string => {
  const text = body.trim().slice(0, MAX_PR_COMMENT);
  if (!text) throw new Error('Nothing to post');
  return text;
};

/** What you can say on a PR: a comment in its conversation, a reply in a thread, or a thread resolved or opened again. */
export type PrPost = { readonly kind: 'comment'; readonly body: string } | { readonly kind: 'reply'; readonly thread: string; readonly body: string } | { readonly kind: 'resolve' | 'unresolve'; readonly thread: string };

/** gh's arguments for a post (exported for tests). */
export function postArgs(number: number, post: PrPost): string[] {
  if (post.kind === 'comment') return ['pr', 'comment', String(number), '--body', clean(post.body)];
  const gql = (query: string, fields: Record<string, string>): string[] => ['api', 'graphql', ...Object.entries(fields).flatMap(([k, v]) => ['-f', `${k}=${v}`]), '-f', `query=${query}`];
  if (post.kind === 'reply') return gql('mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }', { thread: post.thread, body: clean(post.body) });
  const name = post.kind === 'resolve' ? 'resolveReviewThread' : 'unresolveReviewThread';
  return gql(`mutation($thread: ID!) { ${name}(input: { threadId: $thread }) { thread { id } } }`, { thread: post.thread });
}

/** Post it on GitHub as you. Throws gh's error. */
export async function postOnPr(dir: string, number: number, post: PrPost): Promise<void> {
  await runGh(postArgs(number, post), dir, 60_000);
}

/** Ask Claude to work through what reviewers said (all open threads, or one). */
export function addressCommentsPrompt(pr: { readonly number: number; readonly url: string }, thread?: PrThread): string {
  if (thread) {
    const where = `${thread.path}${thread.line ? `:${thread.startLine ? `${thread.startLine}-` : ''}${thread.line}` : ''}`;
    const said = thread.comments.map((c) => `@${c.author}: ${c.body.trim()}`).join('\n\n');
    return [
      `A reviewer commented on ${where} in pull request #${pr.number} (${pr.url}):`,
      '',
      said,
      '',
      'Read the code there and address it: change the code if they are right, or explain why not. Run the tests that cover it and commit. Don’t push or reply on GitHub; say in a few lines what you did, and show the lines you changed in a ```beluga-code block.',
    ].join('\n');
  }
  return [
    `Pull request #${pr.number} (${pr.url}) has review comments. Read them all with \`gh pr view ${pr.number} --comments\` and the open threads on lines with \`gh api repos/{owner}/{repo}/pulls/${pr.number}/comments\`.`,
    'Address each one that is still open: change the code where they are right, or say why not. Run the tests that cover what changed and commit. Don’t push or reply on GitHub.',
    'Then list each comment and what you did about it, showing the lines you changed in ```beluga-code blocks.',
  ].join('\n');
}
