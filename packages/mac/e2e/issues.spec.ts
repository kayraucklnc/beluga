import { expect, test, type Page } from './fixtures.js';

/**
 * GitHub issues (docs/tasks-and-plans.md): the demo's pretend GitHub (acme/bob-api) in Issues, an
 * issue's page, Investigate (a task, a worktree, Claude's report) then Fix It in the same worktree,
 * Make a Task, and the task linking back to its issue.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

async function openIssues(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Issues/ }).click();
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await expect(page.getByRole('button', { name: 'Project: bob-api' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('Issues lists a project’s open and closed issues, and searches them', async ({ page }) => {
  await openIssues(page);
  const rows = main(page).locator('[data-issue]');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('Login returns 500 when the email has a plus sign');
  await expect(rows.first()).toContainText('#48');
  await expect(main(page).getByText('5 open · acme/bob-api')).toBeVisible();
  await page.getByRole('tab', { name: 'Closed' }).click();
  await expect(rows).toHaveCount(3);
  await expect(main(page).locator('[data-issue="33"]').getByRole('img', { name: 'Not planned' })).toBeVisible();
  await page.getByRole('tab', { name: 'Open' }).click();
  await page.getByRole('textbox', { name: 'Search issues on GitHub' }).fill('webhook');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('#47');
});

test('Investigate: a task and a worktree, Claude’s report, then Fix It in the same worktree', async ({ page }) => {
  await openIssues(page);
  await main(page).locator('[data-issue="48"]').click();
  await expect(main(page).getByRole('heading', { name: 'Login returns 500 when the email has a plus sign' })).toBeVisible();
  await expect(main(page).getByText('Same here with')).toBeVisible();
  await expect(main(page).getByText('What should Claude do?')).toBeVisible();
  await main(page).locator('[data-choice="Investigate"]').click();
  // A task for it, and Claude's report once it's done (what happens, why) with Fix It.
  const status = main(page).getByTestId('issue-status');
  await expect(status).toContainText('Claude investigated', { timeout: 30_000 });
  await expect(status).toContainText('decodes the email a second time');
  const task = page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: /BOB-\d+/ });
  await expect(task).toBeVisible();
  const key = /BOB-\d+/.exec((await task.textContent()) ?? '')![0];
  // The worktree is the task's, and stays where it was when you fix it.
  const where = (await status.locator('[class*="mono"]').textContent())!.trim();
  expect(where).toMatch(/^bob-\d+-login-returns-500/);
  await status.getByRole('button', { name: 'Fix It' }).click();
  await expect(status).toContainText(/Claude is fixing it|Claude stopped before a pull request/, { timeout: 30_000 });
  await expect(status).toContainText(where);
  // The task links back to its issue, with what Claude found in its brief.
  await status.getByRole('button', { name: `Open ${key}` }).click();
  const props = page.getByRole('complementary', { name: 'Properties' });
  await expect(props.getByRole('button', { name: /acme\/bob-api#48/ })).toBeVisible();
  await expect(main(page).getByText('decodeURIComponent').first()).toBeVisible();
  await props.getByRole('button', { name: /acme\/bob-api#48/ }).click();
  await expect(main(page).getByRole('heading', { name: 'Login returns 500 when the email has a plus sign' })).toBeVisible();
});

test('Make a Task from an issue: on the board, with its issue mark, once', async ({ page }) => {
  await openIssues(page);
  await main(page).locator('[data-issue="47"]').click();
  await main(page).locator('[data-choice="Make a Task"]').click();
  await page.getByRole('menuitem', { name: /From the Issue/ }).click();
  // The page now offers the task (one per issue), and the board has it with its mark.
  const open = main(page).locator('[data-choice^="Open BOB-"]');
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.getByRole('complementary', { name: 'Properties' }).getByRole('button', { name: /acme\/bob-api#47/ })).toBeVisible();
  await sidebar(page).getByRole('button', { name: /^Tasks/ }).click();
  await expect(main(page).getByRole('button', { name: '#47' })).toBeVisible();
});
