import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** Merge looks before it leaps: a green button that opens what would merge, where, and the checks; nothing changes until you confirm. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const toolbar = (page: Page) => page.locator('main header').first();

test('Merge shows where it goes, what comes along and the checks, and Cancel changes nothing', async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  const unfold = sidebar(page).getByRole('button', { name: "Show what's in bob-api" });
  if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
  await row.click();
  await expect(toolbar(page)).toContainText('add-auth');

  // Green, and it says where.
  const merge = toolbar(page).getByRole('button', { name: 'Merge Locally into main' });
  await expect(merge).toBeVisible();
  const green = await merge.evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = green.match(/\d+/g)!.map(Number);
  expect(g).toBeGreaterThan(r! + 40);
  expect(g).toBeGreaterThan(b! + 30);

  await merge.click();
  const panel = page.getByRole('dialog', { name: 'Merge' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Merge into main' }).or(panel.getByText('Merge into main').first())).toBeVisible();
  await expect(panel.getByLabel(/^From .* into main$/)).toBeVisible();
  await expect(panel).toContainText('From this worktree');
  await expect(panel).toContainText('Into your main folder');
  await expect(panel.getByRole('region', { name: 'What merges' }).or(panel.locator('section[aria-label="What merges"]'))).toContainText(/\d+ commits?/);
  const checks = panel.getByRole('list', { name: 'Checks' });
  await expect(checks.locator('[data-check]').first()).toBeVisible();
  await expect(panel).toContainText('Nothing is pushed');

  // The green button only when every check passes.
  const confirm = panel.locator('[data-merge-confirm]');
  const blocked = await checks.locator('[data-tone="block"]').count();
  if (blocked) await expect(confirm).toBeDisabled();
  else await expect(confirm).toBeEnabled();
  await expect(confirm).toHaveText(/^Merge( \d+ Commits?)?$/);

  // Cancel: closed, and still there to merge.
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel).toBeHidden();
  await expect(merge).toBeVisible();
  // Its button again opens it; pressing it once more closes it.
  await merge.click();
  await expect(panel).toBeVisible();
  await merge.click();
  await expect(panel).toBeHidden();
});

// ---------------------------------------------------------------- Merge on GitHub (a stand-in gh)

/** What the demo daemon's gh (e2e/fake-gh.mjs) knows: its PRs, and the merges it was asked for. */
const ghFile = (): string => path.join(process.env.KLAUD_HOME!, 'fake-gh.json');
const readGh = (): { prs: Record<string, Record<string, unknown>>; merges?: string[][]; mergeError?: string } => JSON.parse(readFileSync(ghFile(), 'utf8'));
const writeGh = (state: object): void => writeFileSync(ghFile(), JSON.stringify(state, null, 2));
const ago = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

function openPr(more: object = {}): Record<string, unknown> {
  return {
    number: 7,
    url: 'https://github.com/bob/api/pull/7',
    state: 'OPEN',
    title: 'Protect the payments routes',
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    autoMergeRequest: null,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: ago(200), completedAt: ago(133), detailsUrl: 'https://github.com/bob/api/actions/runs/1/job/1' },
      { __typename: 'CheckRun', name: 'e2e', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', startedAt: ago(40), completedAt: '0001-01-01T00:00:00Z', detailsUrl: 'https://github.com/bob/api/actions/runs/1/job/2' },
    ],
    ...more,
  };
}

const passed = (): object[] => [
  { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: ago(200), completedAt: ago(133), detailsUrl: 'https://github.com/bob/api/actions/runs/1/job/1' },
  { __typename: 'CheckRun', name: 'e2e', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: ago(90), completedAt: ago(5), detailsUrl: 'https://github.com/bob/api/actions/runs/1/job/2' },
];

test('Merge on GitHub: live checks, the ways to merge, GitHub saying no, then Merged and Archive Worktree', async ({ page }) => {
  writeGh({ prs: { 'add-auth': openPr() } });
  try {
    await page.goto('/');
    await expect(sidebar(page)).toBeVisible();
    const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
    const unfold = sidebar(page).getByRole('button', { name: "Show what's in bob-api" });
    if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
    await row.click();
    await expect(toolbar(page)).toContainText('add-auth');

    // The PR item opens the sheet and looks the PR up at once (the toolbar's own button once the PR is known).
    const prButton = toolbar(page).getByRole('button', { name: /^PR #7/ });
    if (await prButton.isVisible()) await prButton.click();
    else {
      await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
      await page.getByRole('menuitem', { name: /Create PR|PR #/ }).click();
    }
    const sheet = page.getByRole('dialog', { name: /Pull Request/ });
    await expect(sheet).toContainText('#7');
    await expect(sheet).toContainText('Protect the payments routes');

    // Each check: a spinner while it runs, ✓ when done, how long, and its page.
    const checks = sheet.getByRole('list', { name: 'Checks' });
    await expect(checks.locator('[data-check]')).toHaveCount(2);
    await expect(checks.locator('[data-check="running"]')).toContainText('e2e');
    await expect(checks.locator('[data-check="passed"]')).toContainText('1m 07s');
    await expect(checks.getByRole('button', { name: 'Open e2e on GitHub' })).toBeVisible();
    await expect(sheet).toContainText('1 of 2 passed · 1 running');

    // The split button: squash by default; the menu has the other ways and, while checks run, Merge When Checks Pass.
    const merge = sheet.getByRole('button', { name: 'Merge on GitHub' });
    await expect(merge).toHaveAttribute('data-merge-github', 'squash');
    await sheet.getByRole('button', { name: 'More ways to merge' }).click();
    // (Anchored: “Merge When Checks Pass” says how it will merge, “Squash and Merge” among them.)
    for (const way of ['Squash and Merge', 'Create a Merge Commit', 'Rebase and Merge', 'Merge When Checks Pass']) await expect(page.getByRole('menuitem', { name: new RegExp(`^${way}`) })).toBeVisible();
    await page.getByRole('menuitem', { name: /Merge When Checks Pass/ }).click();
    await expect(sheet).toContainText('Merges when checks pass');
    expect(readGh().merges).toEqual([['pr', 'merge', '7', '--squash', '--auto']]);

    // GitHub says no: the sheet says why, in words you can act on.
    writeGh({ ...readGh(), mergeError: 'GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)' });
    await merge.click();
    await expect(sheet.getByRole('alert')).toContainText('approving review');

    // Checks pass and the review is in: it merges, and the sheet and toolbar say Merged, Archive Worktree next.
    const gh = readGh();
    writeGh({ prs: { 'add-auth': openPr({ statusCheckRollup: passed(), reviewDecision: 'APPROVED' }) }, merges: gh.merges });
    await sheet.getByRole('button', { name: 'Refresh status' }).click();
    await expect(sheet).toContainText('Checks passed');
    await merge.click();
    await expect(sheet.locator('[data-pr-state="MERGED"]')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Archive Worktree' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Merge on GitHub' })).toHaveCount(0);
    expect(readGh().merges?.at(-1)).toEqual(['pr', 'merge', '7', '--squash']);
    await page.screenshot({ path: test.info().outputPath('pr-sheet-merged.png') });
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(toolbar(page).locator('[data-pr-state="MERGED"]')).toContainText('PR #7');
    await expect(toolbar(page)).toContainText('Merged on GitHub');
    await expect(toolbar(page).getByRole('button', { name: 'Archive Worktree' })).toBeVisible();
    // The local merge is named for what it is.
    await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
    await expect(page.getByRole('menuitem', { name: /Merge Locally…/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // Project Home: the row shows #7, Merged, and opens the PR sheet.
    await sidebar(page).getByText('bob-api', { exact: true }).first().click();
    const chip = page.getByRole('region', { name: 'Worktrees' }).locator('[data-pr-chip="7"]');
    await expect(chip).toContainText('#7');
    await expect(chip).toContainText('Merged');
    await chip.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Archive Worktree' })).toBeVisible();

    // Put things back for the other tests: no PR on GitHub, and none here.
    rmSync(ghFile());
    // The sheet is live: it may see the PR gone by itself (and swap to Create Pull Request) before Refresh is clicked.
    const create = page.getByRole('dialog', { name: 'Create Pull Request' });
    await expect(async () => {
      if (!(await create.isVisible())) await sheet.getByRole('button', { name: 'Refresh status' }).click({ timeout: 2000 });
      await expect(create).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole('dialog', { name: 'Create Pull Request' }).getByRole('button', { name: 'Cancel' }).click();
  } finally {
    if (existsSync(ghFile())) rmSync(ghFile());
  }
});
