import path from 'node:path';
import { expect, test, type Page } from './fixtures.js';

/**
 * A project's open pull requests on its home (BLG-602): anyone's, from the demo's pretend GitHub
 * (acme/bob-api), not only the ones your worktrees opened. One on a worktree's branch opens that
 * worktree.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');
/** Screenshots for the task's proof (BELUGA_SHOTS: a folder), skipped otherwise. */
const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.BELUGA_SHOTS) await page.screenshot({ path: path.join(process.env.BELUGA_SHOTS, name) });
};

async function openHome(page: Page): Promise<void> {
  await page.goto('/');
  await sidebar(page).getByText('bob-api', { exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeVisible();
}

test('a project’s home lists its open pull requests, and one on a worktree’s branch opens it', async ({ page }) => {
  await openHome(page);
  const section = main(page).getByRole('region', { name: 'Pull Requests' });
  await expect(section).toBeVisible();
  await expect(section.getByRole('heading', { name: /Pull Requests\s*5/ })).toBeVisible();
  const rows = section.locator('[data-pull]');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('Retry webhooks with backoff');
  // Someone else's, with its author, branch, review and checks.
  const teammate = section.locator('[data-pull="51"]');
  await expect(teammate).toContainText('sam-r');
  await expect(teammate).toContainText('fix/plus-in-email');
  await expect(teammate).toContainText('Approved');
  await expect(teammate).toContainText('Checks pass');
  await expect(section.locator('[data-pull="49"]')).toContainText('Draft');
  await expect(section.getByRole('button', { name: 'Show All on GitHub' })).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(page, '01-home-pull-requests.png');
  // #52 is on the webhook-retries worktree's branch: a click opens that worktree.
  await rows.first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'bob-api' })).toBeHidden();
  await expect(page.getByText('webhook-retries').first()).toBeVisible();
});
