import { expect, test, type Page } from '@playwright/test';

/**
 * Never change main: clicking a project opens its home, work starts in a new worktree, and a
 * chat in the main folder is questions only (asking for a change there moves to a worktree).
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const home = (page: Page) => page.getByRole('main');

async function openHome(page: Page, project = 'bob-api'): Promise<void> {
  // The label itself (the row also holds the earnings pill and hover buttons).
  await sidebar(page).getByText(project, { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: project })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
});

test('clicking a project opens its home', async ({ page }) => {
  await openHome(page);
  await expect(page.getByRole('heading', { name: 'What do you want to do in bob-api?' })).toBeVisible();
  await expect(page.getByText('Up to date with origin/main')).toBeVisible();
  const worktrees = page.getByRole('region', { name: 'Worktrees' });
  await expect(worktrees.getByRole('button', { name: /add-auth/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Questions' }).getByRole('button', { name: /How do deploys work/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'New Worktree' })).toHaveAttribute('aria-selected', 'true');
});

test('New Worktree from the home makes a worktree and starts Claude there', async ({ page }) => {
  await openHome(page);
  await page.getByLabel('Task for the new worktree').fill('Add request logging');
  await page.getByLabel('Task for the new worktree').press('Enter');
  // The worktree opens on its conversation (the center no longer has Chat/Files/Diff/Terminal tabs).
  await expect(page.locator('textarea:not(.xterm-helper-textarea)')).toHaveAttribute('placeholder', /Tell Claude what to do in/, { timeout: 15_000 });
  await expect(home(page).getByText('Add request logging').first()).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /add-request-logging/ }).first()).toBeVisible();
  // A worktree, not main: no questions-only banner.
  await expect(page.getByRole('note', { name: 'Questions only' })).toHaveCount(0);
});

test('Just Ask starts a questions-only chat in main, with the banner', async ({ page }) => {
  await openHome(page);
  await page.getByRole('tab', { name: 'Just Ask' }).click();
  await page.getByLabel('Question about bob-api').fill('Where are the routes defined?');
  await page.getByLabel('Question about bob-api').press('Enter');
  const banner = page.getByRole('note', { name: 'Questions only' });
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('Claude won’t change anything in main');
  await expect(page.locator('textarea[placeholder="Ask about bob-api…"]')).toBeVisible();
  await expect(home(page).getByText('Where are the routes defined?').first()).toBeVisible();
});

test('Continue in New Worktree carries the conversation to a new worktree', async ({ page }) => {
  await openHome(page);
  await page.getByRole('tab', { name: 'Just Ask' }).click();
  await page.getByLabel('Question about bob-api').fill('Explain the billing flow');
  await page.getByLabel('Question about bob-api').press('Enter');
  await expect(page.getByRole('note', { name: 'Questions only' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Done in/).last()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('note', { name: 'Questions only' }).getByRole('button', { name: 'Continue in New Worktree…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Continue in a New Worktree' });
  await expect(sheet.getByLabel('Task')).toHaveValue('Explain the billing flow');
  await sheet.getByLabel('Task').fill('Add idempotency keys to billing');
  await sheet.getByRole('button', { name: 'Continue' }).click();
  // Now in the worktree: the conversation came along, Claude works on the task.
  await expect(page.getByRole('note', { name: 'Questions only' })).toHaveCount(0, { timeout: 15_000 });
  await expect(home(page).getByText('Explain the billing flow').first()).toBeVisible();
  await expect(home(page).getByText(/Continued from/)).toBeVisible();
  await expect(home(page).getByText('Add idempotency keys to billing').first()).toBeVisible();
});

test('asking for a change in a questions-only chat moves to a new worktree on its own', async ({ page }) => {
  await openHome(page);
  await page.getByRole('tab', { name: 'Just Ask' }).click();
  await page.getByLabel('Question about bob-api').fill('Fix the typo in the README');
  await page.getByLabel('Question about bob-api').press('Enter');
  await expect(page.getByRole('note', { name: 'Questions only' })).toHaveCount(0, { timeout: 20_000 });
  await expect(home(page).getByText(/Continued from/)).toBeVisible();
  await expect(sidebar(page).getByRole('button', { name: /fix-typo-readme/ }).first()).toBeVisible();
});
