/**
 * A worktree's PR comments shown in its chat, as a fenced block Claude writes when you ask what
 * reviewers said:
 *
 *   ```beluga-pr-comments
 *   show: open
 *   path: src/payments
 *   ```
 *
 * The chat draws them read-only (who, the code a comment is on, what they said); answering them
 * is the PR's page. Browser-safe: no Node.
 */

export const PR_COMMENTS_FENCE = 'beluga-pr-comments';

export interface PrCommentsRef {
  /** 'open': threads still open and what reviewers said (the default); 'all': resolved threads too. */
  readonly show: 'open' | 'all';
  /** Only threads on files under this path. */
  readonly path?: string;
}

export function parsePrCommentsRef(code: string): PrCommentsRef {
  let show: PrCommentsRef['show'] = 'open';
  let path: string | undefined;
  for (const line of code.split('\n')) {
    const m = /^\s*(show|path)\s*:\s*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    if (m[1]!.toLowerCase() === 'show') show = /^(all|everything|resolved)$/i.test(m[2]!) ? 'all' : 'open';
    else path = m[2]!.replace(/^\.\//, '') || undefined;
  }
  return { show, ...(path ? { path } : {}) };
}
