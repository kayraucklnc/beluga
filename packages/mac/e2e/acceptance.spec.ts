import { expect, test, type Page } from '@playwright/test';

/**
 * Acceptance criteria that count (KLD-74): one not ticked yet carries its reason ("— deferred: why",
 * "— not done: why") and shows as its own state on the task page, the worktree's strip and the plan's details.
 * The demo's "Add auth to the payment routes" has one of each.
 */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' });
const main = (page: Page) => page.locator('main');

test.describe.configure({ mode: 'serial' });

test('the strip and the task page show deferred and not-done criteria with their reasons', async ({ page }) => {
  await page.goto('/');
  const row = sidebar(page).getByRole('button', { name: 'add-auth', exact: true });
  if (!(await row.isVisible())) await sidebar(page).getByRole('button', { name: 'bob-api' }).first().click({ position: { x: 60, y: 10 } });
  await sidebar(page).getByRole('button', { name: 'add-auth', exact: true }).click();
  const strip = page.getByRole('button', { name: /Add auth to the payment routes/ }).first();
  await expect(strip).toContainText('2/4 · 1 deferred · 1 not done');
  await strip.click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Add auth to the payment routes');
  const criteria = page.getByRole('region', { name: 'Acceptance criteria' });
  await expect(criteria).toContainText('2 of 4 · 1 deferred · 1 not done');
  const deferred = criteria.locator('li[data-state="deferred"]');
  await expect(deferred).toContainText('Tests for missing, expired and valid sessions');
  await expect(deferred).toContainText('Deferred · the expired one comes with that fix');
  await expect(deferred.getByRole('checkbox', { name: /^Deferred/ })).not.toBeChecked();
  await expect(criteria.locator('li[data-state="not_done"]')).toContainText('Not done · next turn, see the handoff');
  // Explained, so it isn't held out of review.
  await expect(page.getByText('Needs its checks')).toHaveCount(0);
});

test('the plan’s task details show the same states', async ({ page }) => {
  await page.goto('/');
  await sidebar(page).getByRole('button', { name: /^Plans/ }).click();
  if (!(await page.getByRole('button', { name: 'Project: bob-api' }).isVisible())) {
    await page.getByRole('button', { name: /^Project: / }).click();
    await page.getByRole('menuitem', { name: /bob-api/ }).click();
  }
  await main(page).getByRole('button', { name: /^Card checkout for launch,/ }).click();
  await expect(main(page).locator('[data-ready="true"]')).toBeVisible({ timeout: 20_000 });
  await main(page).locator('.react-flow__node').filter({ hasText: 'Add auth to the payment routes' }).click();
  const done = page.getByRole('complementary', { name: 'Details' }).getByRole('region', { name: 'Done when' });
  await expect(done.locator('li[data-state="done"]')).toHaveCount(2);
  await expect(done.locator('li[data-state="deferred"]')).toContainText('Deferred · the expired one comes with that fix');
  await expect(done.locator('li[data-state="not_done"]')).toContainText('Not done · next turn, see the handoff');
});
