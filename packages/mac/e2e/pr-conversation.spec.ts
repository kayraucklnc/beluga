import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/** A PR's comments in Beluga (BLG-514): what reviewers said, on which lines, and your answers, without GitHub. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const ghFile = (): string => path.join(process.env.BELUGA_HOME!, 'fake-gh.json');
const readGh = (): { posts?: string[][] } => JSON.parse(readFileSync(ghFile(), 'utf8'));
const ago = (s: number): string => new Date(Date.now() - s * 1000).toISOString();
const shot = (name: string): string => path.join(import.meta.dirname, '../../../.beluga/scratch', name);

const pr = { number: 7, url: 'https://github.com/bob/api/pull/7', state: 'OPEN', title: 'Protect the payments routes', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', autoMergeRequest: null, statusCheckRollup: [] };
const hunk = ['@@ -18,6 +18,9 @@ export function routes(app) {', '   app.get("/health", health);', '-  app.post("/pay", pay);', '+  app.post("/pay", requireAuth, pay);', '+  for (const r of refunds) {', '+    app.post(r.path, requireAuth, r.handler);', '+  }', '   app.get("/me", me);'].join('\n');

const conversation = {
  number: 7,
  url: pr.url,
  comments: { totalCount: 1, nodes: [{ id: 'C1', author: { login: 'mia' }, body: 'Thanks for picking this up! Can we also cover **refunds**?', createdAt: ago(7200), url: `${pr.url}#c1` }] },
  reviews: { totalCount: 1, nodes: [{ id: 'RV1', author: { login: 'bob' }, body: 'A couple of things before this goes in.', state: 'CHANGES_REQUESTED', submittedAt: ago(3600), url: `${pr.url}#rv1` }] },
  reviewThreads: {
    totalCount: 2,
    nodes: [
      { id: 'T1', path: 'src/routes.ts', line: 23, startLine: 21, originalLine: 23, originalStartLine: 21, isResolved: false, isOutdated: false, comments: { nodes: [{ id: 'TC1', author: { login: 'bob' }, body: 'Could this loop live in `refunds.ts`, next to the handlers?', createdAt: ago(3500), url: `${pr.url}#t1`, diffHunk: hunk }] } },
      { id: 'T2', path: 'src/auth.ts', line: 4, originalLine: 4, isResolved: true, isOutdated: true, comments: { nodes: [{ id: 'TC2', author: { login: 'mia' }, body: 'Typo: "authorise"', createdAt: ago(3400), url: `${pr.url}#t2`, diffHunk: '@@ -1,3 +1,4 @@\n import x\n+// authorise\n export' }] } },
    ],
  },
};

/** Open add-auth, and its PR (the sheet looks it up). */
async function openAddAuth(page: Page): Promise<void> {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  const unfold = sidebar(page).getByRole('button', { name: "Show what's in bob-api" }).first();
  if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
  await row.click();
  const toolbar = page.locator('main header').first();
  const known = toolbar.getByRole('button', { name: /^(Open )?PR #7/ });
  if (await known.waitFor({ timeout: 3000 }).then(() => true, () => false)) await known.click();
  else {
    await toolbar.getByRole('button', { name: 'Other steps for this branch' }).click();
    await page.getByRole('menuitem', { name: /Create PR with Instructions/ }).click();
  }
  await expect(page.getByRole('dialog', { name: /Pull Request/ })).toContainText('#7');
}

test('The PR page: every comment with the code it is on, and you reply, resolve and comment there, not in the chat', async ({ page }) => {
  writeFileSync(ghFile(), JSON.stringify({ prs: { 'add-auth': pr }, conversations: { 7: conversation } }, null, 2));
  try {
    await openAddAuth(page);
    const sheet = page.getByRole('dialog', { name: /Pull Request/ });
    await sheet.getByRole('button', { name: 'Comments' }).click();
    await expect(sheet).toBeHidden();

    // Its own page across the center, the chat a click (or Esc) away.
    const prPage = page.locator('[data-pr-page="7"]');
    await expect(prPage).toContainText('Protect the payments routes');
    await expect(prPage).toContainText('1 open thread');
    await expect(page.getByRole('button', { name: 'Back to Chat' })).toBeVisible();
    await expect(prPage).toContainText('requested changes');
    await expect(prPage).toContainText('cover refunds');
    // The open thread: its file and lines, the diff with the commented lines marked, and what was said.
    const thread = prPage.locator('[data-pr-thread="T1"]');
    await expect(thread).toContainText('src/routes.ts');
    await expect(thread).toContainText(':21-23');
    await expect(thread.locator('[data-line="22"]')).toBeVisible();
    await expect(thread).toContainText('Could this loop live in');
    // The resolved one is out of the way until you ask.
    await expect(prPage.locator('[data-pr-thread="T2"]')).toHaveCount(0);
    await page.screenshot({ path: shot('pr-page.png') });

    // Reply in the thread: posted as you, and there once GitHub is read again.
    await thread.getByRole('button', { name: 'Reply' }).click();
    await thread.getByRole('textbox', { name: 'Reply' }).fill('Good call, moving it.');
    await thread.getByRole('button', { name: 'Reply', exact: true }).last().click();
    await expect(thread.getByRole('textbox', { name: 'Reply' })).toHaveCount(0);
    const reply = thread.locator('article').filter({ hasText: 'Good call, moving it.' });
    await expect(reply).toContainText('you');
    await expect(reply).toContainText('replied');
    expect(readGh().posts?.[0]).toContain('thread=T1');

    // Resolve: it folds away.
    await thread.getByRole('button', { name: 'Resolve' }).click();
    await expect(prPage.locator('[data-pr-thread="T1"]')).toHaveCount(0);
    await prPage.getByRole('button', { name: /Show 2 resolved threads/ }).click();
    await expect(prPage.locator('[data-pr-thread="T2"]')).toContainText('Outdated');

    // A comment on the PR itself.
    await prPage.getByRole('textbox', { name: 'Comment on #7' }).fill('Pushed the fixes.');
    await prPage.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(prPage.locator('article').filter({ hasText: 'Pushed the fixes.' })).toBeVisible();

    // Back to the chat: nothing of the conversation in it, the strip counts what was said.
    await page.getByRole('button', { name: 'Back to Chat' }).click();
    await expect(prPage).toHaveCount(0);
    await expect(page.locator('[data-pr-strip="OPEN"] [data-pr-comments]')).toHaveText(/comments/);
    await expect(page.locator('[data-pr-thread]')).toHaveCount(0);
  } finally {
    rmSync(ghFile(), { force: true });
  }
});

test('In the chat: Claude shows the PR comments and the code it means, read-only, and both go where you answer or look', async ({ page }) => {
  writeFileSync(ghFile(), JSON.stringify({ prs: { 'add-auth': pr }, conversations: { 7: conversation } }, null, 2));
  try {
    await openAddAuth(page);
    await page.keyboard.press('Escape');
    const composer = page.locator('textarea:not(.xterm-helper-textarea)').last();
    await composer.fill('What are the comments on this PR?');
    await composer.press('Enter');

    // The comments as cards, with the code they're on; nothing to type into.
    const block = page.locator('[data-pr-comments-block="7"]');
    await expect(block.locator('[data-pr-thread="T1"]')).toContainText('Could this loop live in', { timeout: 20_000 });
    await expect(block.locator('[data-pr-thread="T1"] [data-line="22"]')).toBeVisible();
    await expect(block.locator('[data-pr-thread="T2"]')).toHaveCount(0);
    await expect(block.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
    await expect(block.locator('textarea')).toHaveCount(0);
    // Claude points at code: those lines of the worktree, the highlighted one marked.
    const code = page.locator('[data-code-ref="src/auth.ts"]');
    await expect(code).toContainText('requireUser');
    await expect(code.locator('[data-line="2"]')).toBeVisible();
    await page.screenshot({ path: shot('pr-comments-in-chat.png') });

    // The code's path goes straight to the file.
    await code.locator('[data-go-to-code]').click();
    await expect(page.getByRole('button', { name: 'Back to Chat' })).toBeVisible();
    await expect(page.locator('main')).toContainText('unauthorized');
    await page.keyboard.press('Escape');

    // Answering is the PR page.
    await block.getByRole('button', { name: 'Reply on the PR Page' }).click();
    await expect(page.locator('[data-pr-page="7"]')).toBeVisible();
  } finally {
    rmSync(ghFile(), { force: true });
  }
});
