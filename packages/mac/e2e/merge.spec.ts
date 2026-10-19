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
  const merge = toolbar(page).getByRole('button', { name: 'Merge into main' });
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
