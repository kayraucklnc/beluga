import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

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

  // On GitHub, the next step is the pull request; merging locally is under ⋯, named for what it is.
  await expect(toolbar(page).getByRole('button', { name: 'Create PR…' })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: /Merge Locally into/ })).toHaveCount(0);
  const openMerge = async (): Promise<void> => {
    await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
    await page.getByRole('menuitem', { name: /Merge Locally…/ }).click();
  };
  await openMerge();
  const panel = page.getByRole('dialog', { name: /^Merge/ });
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
  // Still there to merge: ⋯ opens it again, Escape closes it.
  await openMerge();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

// ---------------------------------------------------------------- Merge on GitHub (a stand-in gh)

/** What the demo daemon's gh (e2e/fake-gh.mjs) knows: its PRs, and the merges it was asked for. */
const ghFile = (): string => path.join(process.env.BELUGA_HOME!, 'fake-gh.json');
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
    await toolbar(page).getByRole('button', { name: /^PR #7|^Create PR…$/ }).click();
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
    for (const way of ['Squash and Merge', 'Create a Merge Commit', 'Rebase and Merge', 'Merge When Checks Pass', 'Merge Now, Skipping Checks']) await expect(page.getByRole('menuitem', { name: new RegExp(`^${way}`) })).toBeVisible();
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

test('The chat watches the PR’s checks live, and an admin can merge past them', async ({ page }) => {
  writeGh({ prs: { 'add-auth': openPr() } });
  try {
    await page.goto('/');
    await expect(sidebar(page)).toBeVisible();
    const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
    const unfold = sidebar(page).getByRole('button', { name: "Show what's in bob-api" });
    if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
    await row.click();

    // Above the chat: the PR, its checks open while they run, and Merge on GitHub.
    const strip = page.locator('[data-pr-strip="OPEN"]');
    await expect(strip).toContainText('#7', { timeout: 20_000 });
    await expect(strip).toContainText('1 of 2 passed · 1 running');
    await expect(strip.getByRole('list', { name: 'Checks' }).locator('[data-check="running"]')).toContainText('e2e');
    await page.screenshot({ path: test.info().outputPath('pr-strip-running.png') });

    // Override: merge now, past the running checks (gh's --admin).
    await strip.getByRole('button', { name: 'More ways to merge' }).click();
    await page.getByRole('menuitem', { name: /^Merge Now, Skipping Checks/ }).click();
    await expect(page.locator('[data-pr-strip="MERGED"]')).toBeVisible();
    expect(readGh().merges?.at(-1)).toEqual(['pr', 'merge', '7', '--squash', '--admin']);
    await expect(page.locator('[data-pr-strip="MERGED"]').getByRole('button', { name: 'Archive Worktree' })).toBeVisible();
  } finally {
    if (existsSync(ghFile())) rmSync(ghFile());
  }
});

test('A PR that conflicts says so and offers Resolve Merge Conflicts; a merged one offers Archive, Continue After Merge or Delete', async ({ page }) => {
  writeGh({ prs: { 'add-auth': openPr({ mergeable: 'CONFLICTING' }) } });
  try {
    await page.goto('/');
    await expect(sidebar(page)).toBeVisible();
    const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
    const unfold = sidebar(page).getByRole('button', { name: "Show what's in bob-api" });
    if (!(await row.isVisible()) && (await unfold.isVisible())) await unfold.click();
    await row.click();

    // Conflicts: no Merge button, Resolve Merge Conflicts instead (in the chat and the toolbar), asking first.
    const strip = page.locator('[data-pr-strip="OPEN"]');
    await expect(strip).toContainText('Conflicts with the base', { timeout: 20_000 });
    await expect(strip.getByRole('button', { name: 'Merge on GitHub' })).toHaveCount(0);
    await expect(toolbar(page).getByRole('button', { name: 'Resolve Merge Conflicts…' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('pr-strip-conflicts.png') });
    await strip.getByRole('button', { name: 'Resolve Merge Conflicts…' }).click();
    const ask = page.getByRole('dialog', { name: 'Ask Claude to resolve the merge conflicts?' }).or(page.getByRole('alertdialog', { name: 'Ask Claude to resolve the merge conflicts?' }));
    await expect(ask).toContainText('merges the latest base');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toBeHidden();

    // Merged: done, and the three ways on from here.
    writeGh({ prs: { 'add-auth': openPr({ state: 'MERGED', statusCheckRollup: passed() }) } });
    const merged = page.locator('[data-pr-strip="MERGED"]');
    await expect(merged).toContainText('Merged · done', { timeout: 30_000 });
    await expect(merged.getByRole('button', { name: 'Archive Worktree' })).toBeVisible();
    await merged.getByRole('button', { name: 'Other ways to finish' }).click();
    await expect(page.getByRole('menuitem', { name: /^Delete Worktree…/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /^Continue After Merge…/ }).click();
    const carry = page.getByRole('dialog', { name: 'Continue working after the merge?' }).or(page.getByRole('alertdialog', { name: 'Continue working after the merge?' }));
    await expect(carry).toContainText('the next change gets a new pull request');
    await page.screenshot({ path: test.info().outputPath('continue-after-merge.png') });
    await carry.getByRole('button', { name: 'Cancel' }).click();
    // The toolbar's ⋯ has it too.
    await toolbar(page).getByRole('button', { name: 'More for this workspace' }).click();
    await expect(page.getByRole('menuitem', { name: /^Continue After Merge…/ })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    if (existsSync(ghFile())) rmSync(ghFile());
  }
});
